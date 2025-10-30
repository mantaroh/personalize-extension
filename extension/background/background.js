const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const ACTION_QUEUE_KEY = 'personalizeActionQueue';
const PAGE_STATS_KEY = 'pageStats';
const PAGE_PREFERENCES_KEY = 'pagePreferences';

const taskQueue = [];
let processing = false;

function persistQueueSnapshot() {
  browserApi.storage.local.set({ [ACTION_QUEUE_KEY]: [...taskQueue] }).catch((error) => {
    console.error('Failed to persist queue snapshot', error);
  });
}

function enqueueTask(task, options = { persist: true }) {
  taskQueue.push(task);
  if (options.persist) {
    persistQueueSnapshot();
  }
  processQueue();
}

async function processQueue() {
  if (processing || taskQueue.length === 0) {
    return;
  }

  processing = true;
  const task = taskQueue.shift();
  persistQueueSnapshot();

  try {
    switch (task.type) {
      case 'USER_ACTION':
        await handleUserAction(task.payload);
        break;
      case 'SYNC_HISTORY':
        await handleHistorySync();
        break;
      default:
        console.warn('Unknown task type received', task.type);
    }
  } catch (error) {
    console.error('Failed to process task', task, error);
  } finally {
    processing = false;
    if (taskQueue.length > 0) {
      processQueue();
    }
  }
}

async function handleUserAction(action) {
  const { url, type, meta } = action;
  const storage = await browserApi.storage.local.get({
    [PAGE_STATS_KEY]: {},
    [PAGE_PREFERENCES_KEY]: {}
  });

  const stats = storage[PAGE_STATS_KEY];
  const preferences = storage[PAGE_PREFERENCES_KEY];
  const pageKey = new URL(url).origin;

  if (!stats[pageKey]) {
    stats[pageKey] = { visits: 0, lastInteraction: null };
  }

  stats[pageKey].visits += 1;
  stats[pageKey].lastInteraction = {
    type,
    meta,
    timestamp: Date.now()
  };

  // ランダムな閾値で好みの色を決めるサンプルロジック
  if (stats[pageKey].visits >= 3) {
    preferences[pageKey] = {
      highlightColor: meta?.preferredColor || '#fff6d5',
      lastUpdated: Date.now()
    };
  }

  await browserApi.storage.local.set({
    [PAGE_STATS_KEY]: stats,
    [PAGE_PREFERENCES_KEY]: preferences
  });
}

async function handleHistorySync() {
  const queued = await browserApi.storage.local.get({ [ACTION_QUEUE_KEY]: [] });
  if (!queued[ACTION_QUEUE_KEY].length) {
    return;
  }

  console.info('Syncing queued actions', queued[ACTION_QUEUE_KEY].length);
  await browserApi.storage.local.set({ [ACTION_QUEUE_KEY]: [] });
}

browserApi.runtime.onInstalled.addListener(() => {
  browserApi.alarms.create('history-sync', { periodInMinutes: 5 });
});

browserApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'history-sync') {
    enqueueTask({ type: 'SYNC_HISTORY' });
  }
});

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  switch (message.type) {
    case 'USER_ACTION': {
      enqueueTask({
        type: 'USER_ACTION',
        payload: {
          ...message.payload,
          url: message.payload?.url || sender?.tab?.url || 'about:blank'
        }
      });
      sendResponse({ status: 'queued' });
      break;
    }
    case 'GET_PERSONALIZATION': {
      (async () => {
        const storage = await browserApi.storage.local.get({ [PAGE_PREFERENCES_KEY]: {} });
        const pageKey = new URL(message.url).origin;
        sendResponse({
          preferences: storage[PAGE_PREFERENCES_KEY][pageKey] || null
        });
      })();
      return true;
    }
    default:
      console.warn('Unhandled message type', message.type);
  }

  return undefined;
});

// 保険として Service Worker が起動した際にキューをリプレイ
(async () => {
  const queued = await browserApi.storage.local.get({ [ACTION_QUEUE_KEY]: [] });
  for (const item of queued[ACTION_QUEUE_KEY]) {
    enqueueTask(item, { persist: false });
  }
})();
