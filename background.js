// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// offscreen の生成・破棄、取り込み中タブの目印（バッジ・点灯アイコン・黄色のタブグループ）、タブ終了時の後始末
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

const ICON_IDLE = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
const ICON_ON = { 16: 'icons/icon-on-16.png', 32: 'icons/icon-on-32.png' };
const GROUP_TITLE = 'DualAudio';
const TAB_GROUP_NONE = -1;

async function getCapturedTabId() {
  return (await chrome.storage.session.get('capturedTabId')).capturedTabId ?? null;
}

// 取り込み中タブを黄色のタブグループへ入れる。利用者が既にグループ分けしているタブは触らない
async function markTabGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId !== TAB_GROUP_NONE) return null;
  const groupId = await chrome.tabs.group({ tabIds: tabId });
  await chrome.tabGroups.update(groupId, { color: 'yellow', title: GROUP_TITLE });
  return groupId;
}

// 自分で作ったグループに入ったままのときだけ外す
async function unmarkTabGroup(tabId, groupId) {
  if (groupId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.groupId === groupId) await chrome.tabs.ungroup(tabId);
}

async function setCapturedTab(tabId) {
  const { capturedTabId: prev = null, ownGroupId = null } =
    await chrome.storage.session.get(['capturedTabId', 'ownGroupId']);
  if (prev != null) {
    chrome.action.setBadgeText({ tabId: prev, text: '' }).catch(() => {});
    chrome.action.setIcon({ tabId: prev, path: ICON_IDLE }).catch(() => {});
    await unmarkTabGroup(prev, ownGroupId).catch(() => {});
  }
  let groupId = null;
  if (tabId != null) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e3a33b' });
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
    await chrome.action.setIcon({ tabId, path: ICON_ON });
    groupId = await markTabGroup(tabId).catch(() => null);
  }
  await chrome.storage.session.set({ capturedTabId: tabId, ownGroupId: groupId });
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
