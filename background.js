// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// offscreen の生成・破棄、取り込み中タブのバッジ表示、タブ終了時の後始末
'use strict';

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'タブ音声を取り込み 2 つの出力デバイスへ再生する',
  });
}

async function getCapturedTabId() {
  return (await chrome.storage.session.get('capturedTabId')).capturedTabId ?? null;
}

async function setCapturedTab(tabId) {
  const prev = await getCapturedTabId();
  if (prev != null) chrome.action.setBadgeText({ tabId: prev, text: '' }).catch(() => {});
  await chrome.storage.session.set({ capturedTabId: tabId });
  if (tabId != null) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e3a33b' });
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
  }
}

async function start(msg) {
  await ensureOffscreen();
  // msg 自体は target: 'background' を持つため展開せず必要な項目だけ渡す
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId: msg.streamId,
    tabId: msg.tabId,
    settings: msg.settings,
  });
  await setCapturedTab(res?.capturing ? msg.tabId : null);
  return res;
}

async function stop() {
  let res = { capturing: false, tabId: null, outputs: [] };
  if (await hasOffscreen()) {
    res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    // デバイスを解放するため閉じる
    await chrome.offscreen.closeDocument();
  }
  await setCapturedTab(null);
  return res;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'background') return false;
  const run = {
    start: () => start(msg),
    stop: () => stop(),
    captureEnded: () => stop(),
    capturedTab: async () => ({ tabId: await getCapturedTabId() }),
  }[msg.type];
  if (!run) return false;
  run().then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === await getCapturedTabId()) await stop();
});
