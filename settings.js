// 設定の既定値と保存（popup / background 共通）
'use strict';

const SETTINGS_KEY = 'settings';

function defaultSettings() {
  const out = (deviceId) => ({ deviceId, volume: 1, delayMs: 0, muted: false });
  return { A: out('default'), B: out('off'), autoComp: true };
}

async function loadSettings() {
  const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  const d = defaultSettings();
  return {
    A: { ...d.A, ...saved.A },
    B: { ...d.B, ...saved.B },
    autoComp: saved.autoComp ?? d.autoComp,
  };
}

function saveSettings(settings) {
  return chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
