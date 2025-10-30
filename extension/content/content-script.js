const browserApi = typeof browser !== 'undefined' ? browser : chrome;

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

document.addEventListener('DOMContentLoaded', () => {
  schedulePersonalization();
});

window.addEventListener(
  'scroll',
  () => {
    captureAction('scroll', {
      scrollY: window.scrollY
    });
  },
  { passive: true }
);

document.addEventListener('click', (event) => {
  const preferredColor = window.getComputedStyle(event.target).backgroundColor;
  captureAction('click', {
    x: event.clientX,
    y: event.clientY,
    preferredColor
  });
});

schedulePersonalization();
