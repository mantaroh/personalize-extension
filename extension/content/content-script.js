const browserApi = typeof browser !== 'undefined' ? browser : chrome;

if (window.top === window.self) {
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
      browserApi.runtime.sendMessage({
        type: 'USER_ACTION',
        payload: {
          url: window.location.href,
          type,
          meta
        }
      });
    } catch (error) {
      console.error('Failed to send user action', error);
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
        }
      } catch (error) {
        console.warn('Unable to load personalization preferences', error);
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

    return {
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

      await browserApi.runtime.sendMessage({
        type: 'PAGE_ANALYSIS',
        payload: {
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
        }
      });
    } catch (error) {
      console.warn('Failed to send page analysis', error);
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
