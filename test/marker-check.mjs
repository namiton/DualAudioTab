// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// 取り込み中タブの目印（バッジ・黄色のタブグループ）の付け外しを検証する
// 実行: node test/marker-check.mjs <使い捨てプロファイルのパス>
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR = path.resolve(import.meta.dirname, '..');
const [profile] = process.argv.slice(2);

const proc = spawn(CHROME, [
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let id = 0;
const pending = new Map();
let buf = '';
proc.stdio[4].on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  proc.stdio[3].write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  console.log(`MARK ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
};

try {
  const extId = (await send('Extensions.loadUnpacked', { path: EXT_DIR })).result.id;
  await sleep(1500);
  const targets = (await send('Target.getTargets')).result.targetInfos;
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  const { sessionId } = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).result;
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    return r.result.result.value;
  };
  // tabs 権限が無くタイトルで探せないため、テスト用タブは拡張から作って ID を得る
  const tabIdOf = () => ev(`return (await chrome.tabs.create({ url: 'about:blank', active: false })).id;`);
  const state = (tabId) => ev(`
    const tab = await chrome.tabs.get(${tabId});
    const group = tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId);
    const badge = await chrome.action.getBadgeText({ tabId: ${tabId} });
    return { groupId: tab.groupId, color: group?.color ?? null, title: group?.title ?? null, badge };`);

  const t1 = await tabIdOf('t1');
  const t2 = await tabIdOf('t2');
  const t3 = await tabIdOf('t3');

  await ev(`await setCapturedTab(${t1});`);
  let s = await state(t1);
  check('start: yellow group + badge', s.color === 'yellow' && s.title === 'DualAudio' && s.badge === 'ON', JSON.stringify(s));

  await ev(`await setCapturedTab(${t2});`);
  const s1 = await state(t1);
  const s2 = await state(t2);
  check('switch: previous tab restored', s1.groupId === -1 && s1.badge === '', JSON.stringify(s1));
  check('switch: new tab marked', s2.color === 'yellow' && s2.badge === 'ON', JSON.stringify(s2));

  await ev(`await setCapturedTab(null);`);
  s = await state(t2);
  check('stop: tab restored', s.groupId === -1 && s.badge === '', JSON.stringify(s));

  // 利用者が作ったグループのタブは動かさない
  const userGroup = await ev(`const g = await chrome.tabs.group({ tabIds: ${t3} });
    await chrome.tabGroups.update(g, { color: 'blue', title: 'mine' }); return g;`);
  await ev(`await setCapturedTab(${t3});`);
  s = await state(t3);
  check('user group kept while capturing', s.groupId === userGroup && s.color === 'blue' && s.badge === 'ON', JSON.stringify(s));
  await ev(`await setCapturedTab(null);`);
  s = await state(t3);
  check('user group kept after stop', s.groupId === userGroup && s.badge === '', JSON.stringify(s));
} catch (err) {
  failed = true;
  console.log('MARK error:', err.message);
} finally {
  console.log(`MARK RESULT ${failed ? 'FAIL' : 'PASS'}`);
  await send('Browser.close').catch(() => {});
  setTimeout(() => process.exit(0), 1000);
}
