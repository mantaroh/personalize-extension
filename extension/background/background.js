const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const ACTION_QUEUE_KEY = 'personalizeActionQueue';
const PAGE_STATS_KEY = 'pageStats';
const PAGE_PREFERENCES_KEY = 'pagePreferences';
const DEBUG_MODE_KEY = 'personalizeDebugMode';

const DATABASE_NAME = 'personalize-extension';
const DATABASE_VERSION = 1;
const PAGE_FEATURE_STORE = 'pageFeatures';
const INTERACTION_STORE = 'interactionLogs';
const OPENAI_KEY_STORAGE_KEY = 'personalizeOpenAiKey';
const OPENAI_MODEL_NAME = 'gpt-5.0-multimodal-preview';

const taskQueue = [];
let processing = false;
let dbPromise;

const logger = (() => {
  const prefix = '[personalize]';
  let debugMode = false;

  function output(method, ...args) {
    console[method](prefix, ...args);
  }

  return {
    setDebugMode(value) {
      debugMode = Boolean(value);
      output('info', `Debug mode ${debugMode ? 'enabled' : 'disabled'}`);
    },
    isDebugEnabled() {
      return debugMode;
    },
    debug(...args) {
      if (debugMode) {
        output('debug', ...args);
      }
    },
    info(...args) {
      output('info', ...args);
    },
    warn(...args) {
      output('warn', ...args);
    },
    error(...args) {
      output('error', ...args);
    }
  };
})();

async function initializeDebugMode() {
  try {
    const stored = await browserApi.storage.local.get({ [DEBUG_MODE_KEY]: false });
    logger.setDebugMode(stored[DEBUG_MODE_KEY]);
  } catch (error) {
    logger.warn('Failed to initialize debug mode. Falling back to disabled state.', error);
    logger.setDebugMode(false);
  }
}

initializeDebugMode();

if (browserApi.storage?.onChanged) {
  browserApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, DEBUG_MODE_KEY)) {
      logger.setDebugMode(changes[DEBUG_MODE_KEY]?.newValue);
    }
  });
}

function openDatabase() {
  if (dbPromise) {
    logger.debug('Reusing existing IndexedDB connection');
    return dbPromise;
  }

  logger.debug('Opening IndexedDB connection');
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      logger.info('Applying IndexedDB schema upgrade to version', DATABASE_VERSION);
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
      logger.debug('IndexedDB connection established');
      resolve(request.result);
    };

    request.onerror = () => {
      logger.error('IndexedDB connection failed', request.error);
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
          logger.error('withStore handler threw synchronously', error);
          reject(error);
          tx.abort();
          return;
        }

        tx.oncomplete = () => resolve(handlerResult);
        tx.onerror = () => {
          logger.error('Transaction failed', tx.error);
          reject(tx.error);
        };
        tx.onabort = () => {
          logger.warn('Transaction aborted', tx.error);
          reject(tx.error);
        };
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

  logger.debug('Saved page feature', sanitizedRecord.id, sanitizedRecord.source);
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

  logger.debug('Saved interaction log', sanitizedRecord.id, sanitizedRecord.actionType);
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

function sanitizeContextMetrics(context) {
  const defaults = {
    characterCount: 0,
    paragraphCount: 0,
    headingCount: 0,
    imageCount: 0
  };

  const sanitized = { ...defaults };

  if (context && typeof context === 'object') {
    for (const key of Object.keys(defaults)) {
      const incoming = context[key];
      if (typeof incoming === 'number' && Number.isFinite(incoming)) {
        sanitized[key] = incoming;
      }
    }
  }

  return sanitized;
}

function validatePageAnalysisPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Missing payload' };
  }

  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    return { valid: false, reason: 'URL is required' };
  }

  const sanitized = {
    ...payload,
    url: payload.url,
    title: typeof payload.title === 'string' ? payload.title : '',
    source: payload.source === 'history' ? 'history' : 'live',
    extractedAt: typeof payload.extractedAt === 'number' ? payload.extractedAt : Date.now(),
    visualTrend: typeof payload.visualTrend === 'string' ? payload.visualTrend : '',
    layoutHighlights: typeof payload.layoutHighlights === 'string' ? payload.layoutHighlights : '',
    textSample: typeof payload.textSample === 'string' ? payload.textSample : '',
    viewportSummary: typeof payload.viewportSummary === 'string' ? payload.viewportSummary : ''
  };

  sanitized.context = sanitizeContextMetrics(payload.context);

  return { valid: true, sanitized };
}

function validateUserActionPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Missing payload' };
  }

  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    return { valid: false, reason: 'URL is required' };
  }

  if (typeof payload.type !== 'string' || payload.type.trim() === '') {
    return { valid: false, reason: 'Action type is required' };
  }

  return {
    valid: true,
    sanitized: {
      ...payload,
      meta: sanitizeMeta(payload.meta)
    }
  };
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
    logger.warn('Failed to fetch or parse history page for analysis', url, error);
  }

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch (error) {
      logger.warn('Unable to resolve origin for url', url, error);
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
    logger.warn('LLM summary failed for history entry', url, error);
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
    logger.warn('Failed to load OpenAI API key', error);
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
    logger.warn('OpenAI visual summary failed', error);
    return null;
  }
}

async function analyzeRecentHistory() {
  if (!browserApi.history || typeof browserApi.history.search !== 'function') {
    logger.warn('History API unavailable');
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
    logger.error('Failed to analyze recent history', error);
  }
}

async function buildDiagnosticsSnapshot() {
  const storage = await browserApi.storage.local.get({
    [PAGE_STATS_KEY]: {},
    [PAGE_PREFERENCES_KEY]: {}
  });

  const stats = storage[PAGE_STATS_KEY];
  const preferences = storage[PAGE_PREFERENCES_KEY];

  const snapshot = {
    queueLength: taskQueue.length,
    processing,
    debugMode: logger.isDebugEnabled(),
    trackedPages: Object.keys(stats).length,
    pagesWithPreferences: Object.keys(preferences).length,
    timestamp: Date.now()
  };

  logger.debug('Diagnostics snapshot created', snapshot);
  return snapshot;
}

async function setDebugModePreference(enabled) {
  await browserApi.storage.local.set({ [DEBUG_MODE_KEY]: Boolean(enabled) });
  logger.info('Debug mode preference stored', enabled);
}

async function handlePageAnalysis(analysis) {
  const { valid, sanitized, reason } = validatePageAnalysisPayload(analysis);
  if (!valid) {
    logger.warn('Discarded page analysis payload', reason, analysis);
    return;
  }

  const origin = (() => {
    try {
      return new URL(sanitized.url).origin;
    } catch (error) {
      logger.warn('Fallback origin used for analysis URL', sanitized.url, error);
      return sanitized.url;
    }
  })();

  const record = {
    id: sanitized.id,
    url: sanitized.url,
    origin,
    source: sanitized.source,
    title: sanitized.title,
    extractedAt: sanitized.extractedAt,
    visualTrend: sanitized.visualTrend,
    layoutHighlights: sanitized.layoutHighlights,
    category: sanitized.category,
    textSample: sanitized.textSample,
    viewportSummary: sanitized.viewportSummary,
    context: sanitized.context,
    rawLLMResponse: sanitized.rawLLMResponse
  };

  logger.info('Persisting page analysis', { url: record.url, source: record.source, category: record.category });
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
      logger.warn('Fallback origin used for interaction URL', url, error);
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
  browserApi.storage.local
    .set({ [ACTION_QUEUE_KEY]: [...taskQueue] })
    .then(() => {
      logger.debug('Queue snapshot persisted', taskQueue.length);
    })
    .catch((error) => {
      logger.error('Failed to persist queue snapshot', error);
    });
}

function enqueueTask(task, options = { persist: true }) {
  logger.debug('Enqueue task', task.type, { persist: options.persist });
  taskQueue.push(task);
  if (options.persist) {
    persistQueueSnapshot();
  }
  logger.debug('Queue length', taskQueue.length);
  processQueue();
}

async function processQueue() {
  if (processing || taskQueue.length === 0) {
    logger.debug('Skipping queue processing', { processing, length: taskQueue.length });
    return;
  }

  processing = true;
  const task = taskQueue.shift();
  persistQueueSnapshot();
  logger.debug('Processing task', task.type, 'Remaining queue length', taskQueue.length);

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
        logger.warn('Unknown task type received', task.type);
    }
  } catch (error) {
    logger.error('Failed to process task', task, error);
  } finally {
    processing = false;
    logger.debug('Task finished', task.type);
    if (taskQueue.length > 0) {
      processQueue();
    }
  }
}

async function handleUserAction(action) {
  const { valid, sanitized, reason } = validateUserActionPayload(action);
  if (!valid) {
    logger.warn('Discarded user action payload', reason, action);
    return;
  }

  const { url, type, meta } = sanitized;
  const storage = await browserApi.storage.local.get({
    [PAGE_STATS_KEY]: {},
    [PAGE_PREFERENCES_KEY]: {}
  });

  const stats = storage[PAGE_STATS_KEY];
  const preferences = storage[PAGE_PREFERENCES_KEY];
  let pageKey;
  try {
    pageKey = new URL(url).origin;
  } catch (error) {
    logger.warn('Failed to derive page key from URL, using raw value', url, error);
    pageKey = url;
  }

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

  logger.info('Recorded user action', { pageKey, type, visits: stats[pageKey].visits });
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
        let pageKey;
        try {
          pageKey = new URL(message.url).origin;
        } catch (error) {
          logger.warn('Failed to derive personalization key from URL', message.url, error);
          pageKey = message.url;
        }
        sendResponse({
          preferences: storage[PAGE_PREFERENCES_KEY][pageKey] || null
        });
      })();
      return true;
    }
    case 'GET_DEBUG_MODE': {
      sendResponse({ enabled: logger.isDebugEnabled() });
      break;
    }
    case 'SET_DEBUG_MODE': {
      (async () => {
        await setDebugModePreference(Boolean(message.enabled));
        sendResponse({ enabled: Boolean(message.enabled) });
      })();
      return true;
    }
    case 'GET_DIAGNOSTICS': {
      (async () => {
        const snapshot = await buildDiagnosticsSnapshot();
        sendResponse({ snapshot });
      })();
      return true;
    }
    default:
      logger.warn('Unhandled message type', message.type);
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
