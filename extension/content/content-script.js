const browserApi = typeof browser !== 'undefined' ? browser : chrome;
const DEBUG_MODE_KEY = 'personalizeDebugMode';

const logger = (() => {
  const prefix = '[personalize]';
  let debugMode = false;

  function output(method, ...args) {
    console[method](prefix, ...args);
  }

  return {
    setDebugMode(value) {
      debugMode = Boolean(value);
      output('info', `Content debug mode ${debugMode ? 'enabled' : 'disabled'}`);
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

const debugState = {
  enabled: false
};

let debugIndicator;

function ensureDebugIndicator() {
  if (!debugState.enabled || debugIndicator) {
    return debugIndicator;
  }

  if (!document.body) {
    return null;
  }

  debugIndicator = document.createElement('div');
  debugIndicator.setAttribute('data-personalize-debug-indicator', 'true');
  Object.assign(debugIndicator.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: 2147483647,
    padding: '8px 12px',
    backgroundColor: 'rgba(17, 24, 39, 0.75)',
    color: '#f9fafb',
    fontSize: '12px',
    fontFamily: 'system-ui, sans-serif',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
    pointerEvents: 'none'
  });
  debugIndicator.textContent = 'Personalize extension: デバッグ情報待機中';
  document.body.appendChild(debugIndicator);
  return debugIndicator;
}

function updateDebugIndicator(message) {
  if (!debugState.enabled) {
    return;
  }

  const indicator = ensureDebugIndicator();
  if (!indicator) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString();
  indicator.textContent = `${timestamp} ${message}`;
}

async function refreshDiagnostics(reason) {
  if (!debugState.enabled) {
    return;
  }

  try {
    const response = await browserApi.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
    if (response?.snapshot) {
      logger.debug('Diagnostics snapshot', reason, response.snapshot);
      updateDebugIndicator(`${reason}: キュー ${response.snapshot.queueLength}, ページ ${response.snapshot.trackedPages}`);
    }
  } catch (error) {
    logger.warn('Failed to fetch diagnostics snapshot', error);
  }
}

async function initializeDebugState() {
  try {
    const response = await browserApi.runtime.sendMessage({ type: 'GET_DEBUG_MODE' });
    const enabled = Boolean(response?.enabled);
    debugState.enabled = enabled;
    logger.setDebugMode(enabled);
    if (enabled && document.body) {
      ensureDebugIndicator();
    }
  } catch (error) {
    logger.warn('Failed to initialize debug state', error);
  }
}

if (browserApi.storage?.onChanged) {
  browserApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, DEBUG_MODE_KEY)) {
      return;
    }

    const enabled = Boolean(changes[DEBUG_MODE_KEY]?.newValue);
    debugState.enabled = enabled;
    logger.setDebugMode(enabled);

    if (!enabled && debugIndicator) {
      debugIndicator.remove();
      debugIndicator = undefined;
    } else if (enabled && document.body) {
      ensureDebugIndicator();
    }
  });
}

function markContentScriptActive() {
  try {
    document.documentElement.setAttribute('data-personalize-active', 'true');
  } catch (error) {
    logger.debug('Unable to set active marker', error);
  }
}

function sanitizeNumeric(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return {
      dominantColor: 'transparent',
      primaryFont: 'default',
      baseFontSize: '16px',
      textDensity: 0,
      imageCount: 0,
      paragraphCount: 0,
      headingCount: 0,
      averageParagraphLength: 0,
      layoutStyle: '不明',
      characterCount: 0,
      textSample: ''
    };
  }

  const sanitized = {
    dominantColor: metrics.dominantColor || 'transparent',
    primaryFont: metrics.primaryFont || 'default',
    baseFontSize: metrics.baseFontSize || '16px',
    textDensity: Math.min(Math.max(sanitizeNumeric(metrics.textDensity, 0), 0), 1),
    imageCount: sanitizeNumeric(metrics.imageCount, 0),
    paragraphCount: sanitizeNumeric(metrics.paragraphCount, 0),
    headingCount: sanitizeNumeric(metrics.headingCount, 0),
    averageParagraphLength: sanitizeNumeric(metrics.averageParagraphLength, 0),
    layoutStyle: metrics.layoutStyle || '不明',
    characterCount: sanitizeNumeric(metrics.characterCount, 0),
    textSample: typeof metrics.textSample === 'string' ? metrics.textSample : ''
  };

  return sanitized;
}

function sanitizeContext(context = {}) {
  return {
    characterCount: sanitizeNumeric(context.characterCount, 0),
    paragraphCount: sanitizeNumeric(context.paragraphCount, 0),
    headingCount: sanitizeNumeric(context.headingCount, 0),
    imageCount: sanitizeNumeric(context.imageCount, 0)
  };
}

function sanitizePageAnalysisPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const sanitized = {
    ...payload,
    url: typeof payload.url === 'string' ? payload.url : window.location.href,
    title: typeof payload.title === 'string' ? payload.title : document.title,
    source: payload.source === 'history' ? 'history' : 'live',
    extractedAt: typeof payload.extractedAt === 'number' ? payload.extractedAt : Date.now(),
    visualTrend: typeof payload.visualTrend === 'string' ? payload.visualTrend : '',
    layoutHighlights: typeof payload.layoutHighlights === 'string' ? payload.layoutHighlights : '',
    textSample: typeof payload.textSample === 'string' ? payload.textSample : '',
    viewportSummary: typeof payload.viewportSummary === 'string' ? payload.viewportSummary : ''
  };

  sanitized.context = sanitizeContext(payload.context);

  return sanitized;
}

if (window.top === window.self) {
  logger.info('Content script initializing', window.location.href);
  markContentScriptActive();
  initializeDebugState();

  const scrollInterval = 1500;
  const selectionInterval = 800;
  let lastScrollSent = 0;
  let lastSelectionSent = 0;

  function throttle(fn, wait) {
    let lastCall = 0;
    let timeoutId;

    return (...args) => {
      const now = Date.now();
      const remaining = wait - (now - lastCall);

      if (remaining <= 0) {
        lastCall = now;
        fn(...args);
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          timeoutId = undefined;
          lastCall = Date.now();
          fn(...args);
        }, remaining);
      }
    };
  }

  function captureAction(type, meta = {}) {
    try {
      logger.debug('Dispatching user action', type, meta);
      const message = {
        type: 'USER_ACTION',
        payload: {
          url: window.location.href,
          type,
          meta
        }
      };
      const result = browserApi.runtime.sendMessage(message);
      if (result && typeof result.then === 'function') {
        result
          .then((response) => {
            logger.debug('User action acknowledged', type, response);
            refreshDiagnostics('ユーザー操作送信');
          })
          .catch((error) => {
            logger.warn('User action message rejected', error);
          });
      } else {
        refreshDiagnostics('ユーザー操作送信');
      }
    } catch (error) {
      logger.error('Failed to send user action', error);
    }
  }

  function schedulePersonalization() {
    setTimeout(async () => {
      try {
        const response = await browserApi.runtime.sendMessage({
          type: 'GET_PERSONALIZATION',
          url: window.location.href
        });
        if (response?.preferences?.highlightColor) {
          applyHighlight(response.preferences.highlightColor);
          logger.info('Applied personalization highlight', response.preferences.highlightColor);
          refreshDiagnostics('ハイライト適用');
        }
      } catch (error) {
        logger.warn('Unable to load personalization preferences', error);
      }
    }, 500);
  }

  function applyHighlight(color) {
    const previous = document.querySelector('[data-personalize-highlight="true"]');
    if (previous) {
      previous.removeAttribute('data-personalize-highlight');
      previous.style.outline = '';
      previous.style.outlineOffset = '';
    }

    const target = document.body;
    target.setAttribute('data-personalize-highlight', 'true');
    target.style.outline = `3px solid ${color}`;
    target.style.outlineOffset = '4px';
    target.dataset.personalizeHighlightColor = color;

    if (debugState.enabled) {
      updateDebugIndicator(`ハイライト色: ${color}`);
    }
  }

  function extractViewportTextSample() {
    const points = [0.25, 0.5, 0.75];
    const snippets = [];
    const centerX = Math.floor(window.innerWidth / 2);

    for (const ratio of points) {
      const y = Math.floor(window.innerHeight * ratio);
      const element = document.elementFromPoint(centerX, y);
      if (!element) {
        continue;
      }

      const text = element.innerText || element.textContent || '';
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned) {
        snippets.push(cleaned.slice(0, 160));
      }
    }

    if (snippets.length === 0) {
      const fallback = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return fallback.slice(0, 320);
    }

    return snippets.join(' ').slice(0, 360);
  }

  function detectLayoutStyle() {
    const columns = getComputedStyle(document.body).getPropertyValue('column-count');
    if (columns && Number(columns) > 1) {
      return 'マルチカラム';
    }

    const hasGrid = window.getComputedStyle(document.body).display.includes('grid');
    if (hasGrid) {
      return 'グリッド';
    }

    return 'シングルカラム';
  }

  function collectPageMetrics() {
    if (!document.body) {
      return null;
    }

    const body = document.body;
    const style = window.getComputedStyle(body);
    const textContent = (body.innerText || '').replace(/\s+/g, ' ').trim();
    const characterCount = textContent.length;
    const imageCount = document.images.length;
    const paragraphCount = document.querySelectorAll('p').length;
    const headingCount = document.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
    const averageParagraphLength = paragraphCount
      ? characterCount / paragraphCount
      : characterCount;
    const layoutStyle = detectLayoutStyle();

    const metrics = {
      dominantColor: style.backgroundColor || 'transparent',
      primaryFont: style.fontFamily || 'default',
      baseFontSize: style.fontSize || '16px',
      textDensity: Math.min(characterCount / Math.max(body.innerHTML.length, 1), 1),
      imageCount,
      paragraphCount,
      headingCount,
      averageParagraphLength,
      layoutStyle,
      characterCount,
      textSample: textContent.slice(0, 1000)
    };

    const sanitizedMetrics = sanitizeMetrics(metrics);
    if (logger.isDebugEnabled()) {
      logger.debug('Collected page metrics', sanitizedMetrics);
    }

    return sanitizedMetrics;
  }

  function detectCategoryFromDocument(metrics) {
    const title = document.title || '';
    const text = metrics.textSample || '';
    const keywords = {
      news: ['news', 'press', 'article', 'headline', '速報', 'ニュース'],
      shopping: ['cart', 'buy', 'price', 'sale', '購入', '商品'],
      social: ['comment', 'profile', 'timeline', '返信', 'フォロー'],
      video: ['video', 'watch', '再生', 'ストリーミング'],
      reference: ['docs', 'documentation', 'guide', 'wiki', 'ヘルプ'],
      developer: ['code', 'api', 'github', 'リファレンス', '開発'],
      entertainment: ['music', 'game', 'ライブ', '映画', '番組'],
      finance: ['stock', 'market', 'chart', '金融', '投資']
    };

    const haystack = `${title} ${text}`.toLowerCase();
    let best = 'other';
    let bestScore = 0;

    for (const [category, list] of Object.entries(keywords)) {
      let score = 0;
      for (const keyword of list) {
        if (haystack.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }

      if (score > bestScore) {
        best = category;
        bestScore = score;
      }
    }

    return best;
  }

  async function sendPageAnalysis() {
    try {
      const metrics = collectPageMetrics();
      if (!metrics) {
        return;
      }
      const visualTrend = buildVisualTrend(metrics);
      const layoutHighlights = buildLayoutHighlights(metrics);
      const category = detectCategoryFromDocument(metrics);
      const viewportSummary = extractViewportTextSample();

      const payload = sanitizePageAnalysisPayload({
        url: window.location.href,
        title: document.title,
        source: 'live',
        extractedAt: Date.now(),
        visualTrend,
        layoutHighlights,
        category,
        textSample: metrics.textSample,
        viewportSummary,
        context: {
          characterCount: metrics.characterCount,
          paragraphCount: metrics.paragraphCount,
          headingCount: metrics.headingCount,
          imageCount: metrics.imageCount
        }
      });

      if (!payload) {
        logger.warn('Skipping page analysis due to invalid payload');
        return;
      }

      logger.info('Dispatching page analysis');
      logger.debug('Page analysis payload', payload);
      const result = browserApi.runtime.sendMessage({
        type: 'PAGE_ANALYSIS',
        payload
      });
      if (result && typeof result.then === 'function') {
        result
          .then((response) => {
            logger.debug('Page analysis acknowledged', response);
            refreshDiagnostics('ページ解析送信');
          })
          .catch((error) => {
            logger.warn('Page analysis message rejected', error);
          });
      } else {
        refreshDiagnostics('ページ解析送信');
      }
    } catch (error) {
      logger.warn('Failed to send page analysis', error);
    }
  }

  function buildVisualTrend(metrics) {
    return [
      `背景色: ${metrics.dominantColor}`,
      `基準フォント: ${metrics.primaryFont}`,
      `文字サイズ: ${metrics.baseFontSize}`,
      `テキスト密度: ${(metrics.textDensity * 100).toFixed(0)}%`,
      `画像枚数: ${metrics.imageCount}`,
      `レイアウト: ${metrics.layoutStyle}`
    ].join(' / ');
  }

  function buildLayoutHighlights(metrics) {
    return [
      `段落数: ${metrics.paragraphCount}`,
      `見出し数: ${metrics.headingCount}`,
      `平均段落長: ${Math.round(metrics.averageParagraphLength)}文字`
    ].join(' / ');
  }

  function handleScroll() {
    const now = Date.now();
    if (now - lastScrollSent < scrollInterval) {
      return;
    }
    lastScrollSent = now;

    captureAction('scroll', {
      scrollY: window.scrollY,
      viewportText: extractViewportTextSample()
    });
  }

  function handleSelectionChange() {
    const now = Date.now();
    if (now - lastSelectionSent < selectionInterval) {
      return;
    }

    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const text = (selection.toString() || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }

    lastSelectionSent = now;
    captureAction('text-selection', {
      length: text.length,
      snippet: text.slice(0, 280)
    });
  }

  function initializeZoomTracking() {
    if (!window.visualViewport) {
      return;
    }

    let lastScale = window.visualViewport.scale;
    const notifyZoom = throttle(() => {
      const scale = window.visualViewport.scale;
      if (Math.abs(scale - lastScale) < 0.01) {
        return;
      }

      lastScale = scale;
      captureAction('zoom', {
        scale: Number(scale.toFixed(2))
      });
    }, 400);

    window.visualViewport.addEventListener('resize', notifyZoom, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    markContentScriptActive();
    if (debugState.enabled) {
      ensureDebugIndicator();
    }
    schedulePersonalization();
    sendPageAnalysis();
  });

  window.addEventListener('load', () => {
    sendPageAnalysis();
  });

  window.addEventListener('scroll', handleScroll, { passive: true });

  document.addEventListener('click', (event) => {
    const preferredColor = window.getComputedStyle(event.target).backgroundColor;
    captureAction('click', {
      x: event.clientX,
      y: event.clientY,
      preferredColor
    });
  });

  document.addEventListener('selectionchange', handleSelectionChange);

  initializeZoomTracking();

  schedulePersonalization();
  sendPageAnalysis();
}
