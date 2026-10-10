// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// 取り込み〜A/B 出力の診断: テストトーンのタブを取り込み、offscreen の状態を調べる
// 実行: node test/capture-check.mjs <使い捨てプロファイルのパス>
// アイコン操作の代わりに、拡張ページから getMediaStreamId を試みる（失敗した場合はエラー内容を出す）
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR = path.resolve(import.meta.dirname, '..');
const [profile] = process.argv.slice(2);

const proc = spawn(CHROME, [
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let id = 0;
const pending = new Map();
const listeners = [];
let buf = '';
proc.stdio[4].on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else listeners.forEach((fn) => fn(msg));
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  proc.stdio[3].write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function attach(targetId, label) {
  const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') console.log(`CAP [${label}] exception:`, m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled') console.log(`CAP [${label}] console.${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
const evaluate = async (sessionId, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  return r.result?.exceptionDetails ? `EXCEPTION ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
};

try {
  const extId = (await send('Extensions.loadUnpacked', { path: EXT_DIR })).result.id;
  // テストトーンを鳴らすタブ
  const toneHtml = 'data:text/html,<title>tone</title><script>const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();g.gain.value=0.05;o.connect(g).connect(c.destination);o.start();</script>';
  const toneTarget = (await send('Target.createTarget', { url: toneHtml })).result.targetId;
  await sleep(1500);
  const popupTarget = (await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` })).result.targetId;
  await sleep(1500);
  const popup = await attach(popupTarget, 'popup');

  const tabId = await evaluate(popup, `chrome.tabs.query({ title: 'tone' }).then((t) => t[0]?.id)`);
  console.log('CAP tone tabId:', tabId);
  const started = await evaluate(popup, `(async () => {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: ${tabId} });
      const settings = await loadSettings();
      settings.B.deviceId = 'default';
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start', streamId, tabId: ${tabId}, settings });
      return JSON.stringify(res);
    } catch (e) { return 'ERROR ' + e.message; }
  })()`);
  console.log('CAP start result:', started);

  // 開始命令が offscreen まで届くかの検証: 無効な streamId を送り、offscreen 由来のエラーが返ること
  const relay = await evaluate(popup, `chrome.runtime.sendMessage({ target: 'background', type: 'start',
      streamId: 'invalid-stream-id', tabId: -1, settings: defaultSettings() })
    .then((r) => JSON.stringify(r ?? null), (e) => 'REJECTED ' + e.message)`);
  const reached = typeof relay === 'string' && relay.includes('"error"');
  console.log(`CAP relay ${reached ? 'PASS' : 'FAIL'}: start message reached offscreen -> ${relay}`);
  await evaluate(popup, `chrome.runtime.sendMessage({ target: 'background', type: 'stop' }).then(() => 'ok', (e) => e.message)`);

  await sleep(2000);
  let targets = (await send('Target.getTargets')).result.targetInfos;
  // tabCapture が使えない場合は offscreen を作り、合成音で出力側だけを検証する
  if (!targets.some((t) => t.url.includes('offscreen.html'))) {
    const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const swSession = await attach(sw.targetId, 'sw');
    console.log('CAP ensureOffscreen:', await evaluate(swSession, 'ensureOffscreen().then(() => "ok", (e) => "ERROR " + e.message)'));
    await sleep(1000);
    targets = (await send('Target.getTargets')).result.targetInfos;
    const offT = targets.find((t) => t.url.includes('offscreen.html'));
    const s = await attach(offT.targetId, 'offscreen-synth');
    console.log('CAP synth start:', await evaluate(s, `(async () => {
      const gen = new AudioContext();
      const osc = gen.createOscillator();
      const g = gen.createGain(); g.gain.value = 0.05;
      const dest = gen.createMediaStreamDestination();
      osc.connect(g).connect(dest); osc.start();
      window.__gen = gen;
      stream = dest.stream;
      outputs.forEach((o) => { o.stream = stream; });
      const d = { deviceId: 'default', volume: 1, delayMs: 0, muted: false };
      await applySettings({ A: d, B: { ...d }, autoComp: true });
      await new Promise((r) => setTimeout(r, 1500));
      return JSON.stringify(status());
    })()`));
  }
  const off = targets.find((t) => t.url.includes('offscreen.html'));
  console.log('CAP offscreen target:', off ? off.type : 'none');
  if (off) {
    const offSession = await attach(off.targetId, 'offscreen');
    console.log('CAP offscreen status:', await evaluate(offSession, 'JSON.stringify(status())'));
    console.log('CAP offscreen detail:', await evaluate(offSession, `JSON.stringify({
      stream: !!stream, tracks: stream?.getAudioTracks().map((t) => t.readyState + '/' + t.muted),
      outputs: outputs.map((o) => ({ deviceId: o.deviceId, hasStream: !!o.stream, ctx: o.ctx?.state })) })`));
  }
} catch (err) {
  console.log('CAP error:', err.message);
} finally {
  await send('Browser.close').catch(() => {});
  setTimeout(() => process.exit(0), 1000);
}
