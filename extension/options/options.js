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

function readLocalSetting(key, fallback = '') {
  try {
    const stored = localStorage.getItem(key);
    return stored ?? fallback;
  } catch (error) {
    console.warn('[personalize] Failed to read localStorage', error);
    return fallback;
  }
}

function writeLocalSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('[personalize] Failed to write localStorage', error);
  }
}

async function syncSettingToExtensionStorage(key, value) {
  if (!browserApi.storage?.local) {
    return;
  }

  try {
    await browserApi.storage.local.set({ [key]: value });
  } catch (error) {
    console.warn('[personalize] Failed to sync setting to storage', error);
  }
}

function setStatus(element, message, isError = false) {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.classList.toggle('error', isError);
}

function loadSettings() {
  const apiKey = readLocalSetting(OPENAI_KEY_STORAGE_KEY, '');
  elements.openAiKey.value = apiKey;

  const debugStored = readLocalSetting(DEBUG_MODE_KEY, 'false');
  const debugEnabled = debugStored === 'true';
  elements.debugMode.checked = debugEnabled;
  if (debugEnabled) {
    setStatus(elements.debugStatus, 'デバッグログが有効です。');
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

  writeLocalSetting(OPENAI_KEY_STORAGE_KEY, value);
  await syncSettingToExtensionStorage(OPENAI_KEY_STORAGE_KEY, value);
  setStatus(elements.keyStatus, 'API キーを保存しました。');
  elements.saveKey.disabled = false;
}

async function handleDebugToggle(event) {
  const enabled = event.target.checked;
  writeLocalSetting(DEBUG_MODE_KEY, String(enabled));
  await syncSettingToExtensionStorage(DEBUG_MODE_KEY, enabled);
  setStatus(elements.debugStatus, enabled ? 'デバッグログが有効です。' : 'デバッグログを無効にしました。');
}

loadSettings();

if (elements.saveKey) {
  elements.saveKey.addEventListener('click', handleSaveApiKey);
}

if (elements.debugMode) {
  elements.debugMode.addEventListener('change', handleDebugToggle);
}
