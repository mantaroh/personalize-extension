const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const ACTION_QUEUE_KEY = 'personalizeActionQueue';
const PAGE_STATS_KEY = 'pageStats';
const PAGE_PREFERENCES_KEY = 'pagePreferences';

const DATABASE_NAME = 'personalize-extension';
const DATABASE_VERSION = 1;
const PAGE_FEATURE_STORE = 'pageFeatures';
const INTERACTION_STORE = 'interactionLogs';
const OPENAI_KEY_STORAGE_KEY = 'personalizeOpenAiKey';
const OPENAI_MODEL_NAME = 'gpt-5.0-multimodal-preview';

const taskQueue = [];
let processing = false;
let dbPromise;

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(PAGE_FEATURE_STORE)) {
        const pageStore = db.createObjectStore(PAGE_FEATURE_STORE, {
          keyPath: 'id'
        });
        pageStore.createIndex('byOrigin', 'origin', { unique: false });
        pageStore.createIndex('byUrl', 'url', { unique: false });
        pageStore.createIndex('bySource', 'source', { unique: false });
        pageStore.createIndex('byCategory', 'category', { unique: false });
      }

      if (!db.objectStoreNames.contains(INTERACTION_STORE)) {
        const interactionStore = db.createObjectStore(INTERACTION_STORE, {
          keyPath: 'id'
        });
        interactionStore.createIndex('byOrigin', 'origin', { unique: false });
        interactionStore.createIndex('byUrl', 'url', { unique: false });
        interactionStore.createIndex('byType', 'actionType', { unique: false });
        interactionStore.createIndex('byTimestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });

  return dbPromise;
}

function withStore(storeName, mode, handler) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);

        let handlerResult;
        try {
          handlerResult = handler(store, tx);
        } catch (error) {
          reject(error);
          tx.abort();
          return;
        }

        tx.oncomplete = () => resolve(handlerResult);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

async function savePageFeature(record) {
  const sanitizedRecord = {
    ...record,
    id: record.id || (record.source === 'history' ? `${record.origin}::history` : generateId()),
    visualTrend: truncateText(record.visualTrend, 1200),
    layoutHighlights: truncateText(record.layoutHighlights, 1200),
    category: truncateText(record.category, 120),
    textSample: truncateText(record.textSample, 2000),
    rawLLMResponse: record.rawLLMResponse ? truncateText(record.rawLLMResponse, 4000) : undefined
  };

  await withStore(PAGE_FEATURE_STORE, 'readwrite', (store) => {
    store.put(sanitizedRecord);
  });

  return sanitizedRecord.id;
}

async function saveInteractionLog(record) {
  const sanitizedRecord = {
    ...record,
    id: record.id || generateId(),
    meta: sanitizeMeta(record.meta)
  };

  await withStore(INTERACTION_STORE, 'readwrite', (store) => {
    store.put(sanitizedRecord);
  });

  return sanitizedRecord.id;
}

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function truncateText(value, limit) {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string') {
      sanitized[key] = truncateText(value, 800);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.slice(0, 20).map((item) => {
        if (typeof item === 'string') {
          return truncateText(item, 200);
        }
        return item;
      });
    }
  }

  return sanitized;
}

function summarizeStructureMetrics(metrics) {
  const parts = [];
  if (typeof metrics.headingCount === 'number') {
    parts.push(`見出し: ${metrics.headingCount}`);
  }
  if (typeof metrics.paragraphCount === 'number') {
    parts.push(`段落: ${metrics.paragraphCount}`);
  }
  if (typeof metrics.imageCount === 'number') {
    parts.push(`画像: ${metrics.imageCount}`);
  }
  if (typeof metrics.averageParagraphLength === 'number') {
    parts.push(`平均段落長: ${Math.round(metrics.averageParagraphLength)}文字`);
  }
  if (typeof metrics.textToImageRatio === 'number') {
    parts.push(`テキスト/画像比: ${metrics.textToImageRatio.toFixed(2)}`);
  }

  return parts.join(' / ');
}

function detectCategoryFromText(title, bodyText) {
  const CATEGORY_KEYWORDS = {
    news: ['news', 'breaking', 'press', 'headline', '記事', 'ニュース'],
    shopping: ['shop', 'cart', 'buy', 'sale', '商品', '購入', '通販'],
    social: ['profile', 'followers', 'comment', 'post', 'sns', 'ソーシャル', 'tweet'],
    video: ['video', 'watch', 'stream', 'movie', '配信', '動画'],
    reference: ['wiki', 'reference', 'documentation', 'guide', 'faq', 'ヘルプ'],
    developer: ['code', 'developer', 'api', 'github', 'プログラミング', '技術'],
    entertainment: ['music', 'game', 'anime', '漫画', 'entertainment', 'ライブ'],
    finance: ['stock', 'market', 'finance', 'bank', '投資', '金融']
  };

  const haystack = `${title || ''} ${bodyText || ''}`.toLowerCase();
  let matchedCategory = 'other';
  let maxMatches = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let matches = 0;
    for (const keyword of keywords) {
      if (haystack.includes(keyword.toLowerCase())) {
        matches += 1;
      }
    }

    if (matches > maxMatches && matches > 0) {
      matchedCategory = category;
      maxMatches = matches;
    }
  }

  return matchedCategory;
}

function buildVisualTrendDescription({
  dominantColor,
  primaryFont,
  baseFontSize,
  textDensity,
  imageCount,
  layoutStyle
}) {
  const trendParts = [];
  if (dominantColor) {
    trendParts.push(`背景/基調色は ${dominantColor}。`);
  }
  if (primaryFont) {
    trendParts.push(`主要フォントは ${primaryFont}。`);
  }
  if (baseFontSize) {
    trendParts.push(`基準フォントサイズは ${baseFontSize}。`);
  }
  if (typeof textDensity === 'number') {
    trendParts.push(`テキスト密度は ${(textDensity * 100).toFixed(0)}%。`);
  }
  if (typeof imageCount === 'number') {
    trendParts.push(`画像枚数は ${imageCount} 枚。`);
  }
  if (layoutStyle) {
    trendParts.push(`レイアウトは ${layoutStyle} 傾向。`);
  }

  return trendParts.join(' ');
}

async function analyzeHistoryEntry(historyItem) {
  const { url } = historyItem;
  let bodyText = '';
  let title = historyItem.title || '';
  let documentMetrics = {
    headingCount: 0,
    paragraphCount: 0,
    imageCount: 0,
    averageParagraphLength: 0,
    textToImageRatio: 0
  };

  try {
    const response = await fetch(url, { method: 'GET' });
    if (response.ok) {
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      title = doc.title || title;
      const textContent = doc.body ? doc.body.textContent || '' : '';
      bodyText = textContent.replace(/\s+/g, ' ').trim();

      const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const paragraphs = doc.querySelectorAll('p');
      const images = doc.querySelectorAll('img');
      const paragraphsLength = Array.from(paragraphs).map((p) => (p.textContent || '').trim().length);
      const totalParagraphLength = paragraphsLength.reduce((acc, length) => acc + length, 0);

      documentMetrics = {
        headingCount: headings.length,
        paragraphCount: paragraphs.length,
        imageCount: images.length,
        averageParagraphLength: paragraphsLength.length ? totalParagraphLength / paragraphsLength.length : 0,
        textToImageRatio: images.length ? paragraphs.length / images.length : paragraphs.length
      };
    }
  } catch (error) {
    console.warn('Failed to fetch or parse history page for analysis', url, error);
  }

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch (error) {
      console.warn('Unable to resolve origin for url', url, error);
      return url;
    }
  })();

  const visualTrend = buildVisualTrendDescription({
    dominantColor: '不明',
    primaryFont: '不明',
    baseFontSize: '不明',
    textDensity: bodyText ? Math.min(bodyText.length / 5000, 1) : 0,
    imageCount: documentMetrics.imageCount,
    layoutStyle: documentMetrics.headingCount > 5 ? '情報量の多い構成' : 'シンプルな構成'
  });

  const layoutHighlights = summarizeStructureMetrics(documentMetrics);
  const category = detectCategoryFromText(title, bodyText);

  let llmSummary;
  try {
    llmSummary = await runGpt5VisualSummary({
      title,
      bodyText,
      visualTrend,
      layoutHighlights
    });
  } catch (error) {
    console.warn('LLM summary failed for history entry', url, error);
  }

  const record = {
    url,
    origin,
    source: 'history',
    title,
    extractedAt: Date.now(),
    visualTrend: llmSummary?.visualTrend || visualTrend,
    layoutHighlights,
    category,
    textSample: truncateText(bodyText, 2000),
    context: {
      visitCount: historyItem.visitCount || 0,
      lastVisitTime: historyItem.lastVisitTime || Date.now()
    },
    rawLLMResponse: llmSummary?.raw
  };

  await savePageFeature(record);
}

async function runGpt5VisualSummary({ title, bodyText, visualTrend, layoutHighlights }) {
  let apiKey;
  try {
    const storage = await browserApi.storage.local.get({ [OPENAI_KEY_STORAGE_KEY]: null });
    apiKey = storage[OPENAI_KEY_STORAGE_KEY];
  } catch (error) {
    console.warn('Failed to load OpenAI API key', error);
  }

  if (!apiKey) {
    return null;
  }

  const prompt = `以下のページ情報から、画面全体の傾向を150文字以内で要約してください。\n` +
    `タイトル: ${title || '不明'}\n` +
    `ヒューリスティック要約: ${visualTrend}\n` +
    `レイアウト情報: ${layoutHighlights}\n` +
    `本文抜粋: ${truncateText(bodyText || '', 800)}`;

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_NAME,
        input: [
          { role: 'system', content: 'You are a UX trend analyst who summarizes visual and layout characteristics for personalization systems.' },
          { role: 'user', content: prompt }
        ],
        max_output_tokens: 300
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }

    const result = await response.json();
    const text = result.output?.[0]?.content?.[0]?.text || result.choices?.[0]?.message?.content || '';

    if (!text) {
      return null;
    }

    return {
      visualTrend: truncateText(text, 400),
      raw: JSON.stringify(result)
    };
  } catch (error) {
    console.warn('OpenAI visual summary failed', error);
    return null;
  }
}

async function analyzeRecentHistory() {
  if (!browserApi.history || typeof browserApi.history.search !== 'function') {
    console.warn('History API unavailable');
    return;
  }

  try {
    const historyItems = await browserApi.history.search({ text: '', maxResults: 100, startTime: 0 });
    const domainMap = new Map();

    for (const item of historyItems) {
      if (!item.url) {
        continue;
      }

      let origin;
      try {
        origin = new URL(item.url).origin;
      } catch (error) {
        origin = item.url;
      }

      const stored = domainMap.get(origin);
      if (!stored || (item.lastVisitTime || 0) > (stored.lastVisitTime || 0)) {
        domainMap.set(origin, item);
      }
    }

    const analyses = [];
    for (const item of domainMap.values()) {
      analyses.push(analyzeHistoryEntry(item));
    }

    await Promise.allSettled(analyses);
  } catch (error) {
    console.error('Failed to analyze recent history', error);
  }
}

async function handlePageAnalysis(analysis) {
  if (!analysis || !analysis.url) {
    return;
  }

  const origin = (() => {
    try {
      return new URL(analysis.url).origin;
    } catch (error) {
      return analysis.url;
    }
  })();

  const record = {
    id: analysis.id,
    url: analysis.url,
    origin,
    source: analysis.source || 'live',
    title: analysis.title,
    extractedAt: analysis.extractedAt || Date.now(),
    visualTrend: analysis.visualTrend,
    layoutHighlights: analysis.layoutHighlights,
    category: analysis.category,
    textSample: analysis.textSample,
    viewportSummary: analysis.viewportSummary,
    context: analysis.context,
    rawLLMResponse: analysis.rawLLMResponse
  };

  await savePageFeature(record);
}

async function recordInteraction(action) {
  const { url, type, meta } = action;
  if (!url) {
    return;
  }

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch (error) {
      return url;
    }
  })();

  await saveInteractionLog({
    url,
    origin,
    actionType: type,
    meta,
    timestamp: Date.now()
  });
}

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
      case 'PAGE_ANALYSIS':
        await handlePageAnalysis(task.payload);
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
    meta: sanitizeMeta(meta),
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

  await recordInteraction({ url, type, meta });
}

async function handleHistorySync() {
  await analyzeRecentHistory();
}

browserApi.runtime.onInstalled.addListener(() => {
  browserApi.alarms.create('history-sync', { periodInMinutes: 5 });
  enqueueTask({ type: 'SYNC_HISTORY' });
});

if (browserApi.runtime.onStartup) {
  browserApi.runtime.onStartup.addListener(() => {
    enqueueTask({ type: 'SYNC_HISTORY' });
  });
}

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
    case 'PAGE_ANALYSIS': {
      enqueueTask({
        type: 'PAGE_ANALYSIS',
        payload: message.payload
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
