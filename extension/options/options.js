const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const OPENAI_KEY_STORAGE_KEY = 'personalizeOpenAiApiKey';
const DEBUG_MODE_KEY = 'personalizeDebugMode';

const elements = {
  openAiKey: document.getElementById('openai-key'),
  saveKey: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  debugMode: document.getElementById('debug-mode'),
  debugStatus: document.getElementById('debug-status')
};

function setStatus(element, message, isError = false) {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function loadSettings() {
  if (!browserApi.storage?.local) {
    setStatus(elements.keyStatus, 'ブラウザのストレージにアクセスできません。', true);
    setStatus(elements.debugStatus, 'ブラウザのストレージにアクセスできません。', true);
    if (elements.saveKey) {
      elements.saveKey.disabled = true;
    }
    if (elements.openAiKey) {
      elements.openAiKey.disabled = true;
    }
    if (elements.debugMode) {
      elements.debugMode.disabled = true;
    }
    return;
  }

  try {
    const stored = await browserApi.storage.local.get({
      [OPENAI_KEY_STORAGE_KEY]: '',
      [DEBUG_MODE_KEY]: false
    });

    elements.openAiKey.value = stored[OPENAI_KEY_STORAGE_KEY] ?? '';
    const debugEnabled = Boolean(stored[DEBUG_MODE_KEY]);
    elements.debugMode.checked = debugEnabled;
    if (debugEnabled) {
      setStatus(elements.debugStatus, 'デバッグログが有効です。');
    }
  } catch (error) {
    console.warn('[personalize] Failed to load settings', error);
    setStatus(elements.keyStatus, '設定の読み込みに失敗しました。', true);
    setStatus(elements.debugStatus, '設定の読み込みに失敗しました。', true);
  }
}

async function handleSaveApiKey() {
  const value = elements.openAiKey.value.trim();
  elements.saveKey.disabled = true;

  if (!value) {
    setStatus(elements.keyStatus, 'API キーを入力してください。', true);
    elements.saveKey.disabled = false;
    return;
  }

  try {
    await browserApi.storage.local.set({ [OPENAI_KEY_STORAGE_KEY]: value });
    setStatus(elements.keyStatus, 'API キーを保存しました。');
  } catch (error) {
    console.warn('[personalize] Failed to save API key', error);
    setStatus(elements.keyStatus, 'API キーの保存に失敗しました。', true);
  } finally {
    elements.saveKey.disabled = false;
  }
}

async function handleDebugToggle(event) {
  const enabled = event.target.checked;
  try {
    await browserApi.storage.local.set({ [DEBUG_MODE_KEY]: enabled });
    setStatus(elements.debugStatus, enabled ? 'デバッグログが有効です。' : 'デバッグログを無効にしました。');
  } catch (error) {
    console.warn('[personalize] Failed to update debug mode', error);
    setStatus(elements.debugStatus, 'デバッグログの更新に失敗しました。', true);
    event.target.checked = !enabled;
  }
}

void loadSettings();

if (elements.saveKey) {
  elements.saveKey.addEventListener('click', handleSaveApiKey);
}

if (elements.debugMode) {
  elements.debugMode.addEventListener('change', handleDebugToggle);
}
