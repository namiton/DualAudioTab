// 使い捨てプロファイルの Chrome に拡張を読み込み、ポップアップ画面の表示とエラーを確認する
// 実行: node test/load-check.mjs <使い捨てプロファイルのパス> [スクリーンショット保存先.png]
// Chrome 137 以降は --load-extension が無効のため、CDP（pipe）の Extensions.loadUnpacked を使う
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR = path.resolve(import.meta.dirname, '..');
const [profile, shotPath] = process.argv.slice(2);
if (!profile) throw new Error('profile path required');

const proc = spawn(CHROME, [
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

const toChrome = proc.stdio[3];
const fromChrome = proc.stdio[4];
let id = 0;
const pending = new Map();
const listeners = [];
let buf = '';
fromChrome.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      listeners.forEach((fn) => fn(msg));
    }
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  toChrome.write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const loaded = await send('Extensions.loadUnpacked', { path: EXT_DIR });
  if (loaded.error) throw new Error(`loadUnpacked: ${loaded.error.message}`);
  const extId = loaded.result.id;
  console.log('LOAD extension id:', extId);

  // service worker の起動確認
  await sleep(1500);
  const targets = (await send('Target.getTargets')).result.targetInfos;
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  console.log('LOAD service worker:', sw ? 'running' : 'not found');

  // ポップアップをタブとして開いて描画とエラーを確認
  const { targetId } = (await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` })).result;
  const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
  const errors = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.reload', {}, sessionId);
  await sleep(2000);
  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      button: document.getElementById('startStop').textContent,
      status: document.getElementById('statusText').textContent,
      channels: [...document.querySelectorAll('.ch-badge')].map((b) => b.textContent),
      devicesA: [...document.querySelectorAll('.output[data-out="A"] option')].map((o) => o.text),
      permissionButton: !document.getElementById('permission').hidden,
    })`,
    returnByValue: true,
  }, sessionId);
  console.log('LOAD popup state:', state.result.result.value);
  // +/- ボタン: 実マウス操作で 1 回押し・長押し・下限での − を確認
  const valueOf = async (sel) => (await send('Runtime.evaluate', {
    expression: `document.querySelector('.output[data-out="A"] ${sel}').value`, returnByValue: true,
  }, sessionId)).result.result.value;
  const press = async (sel, holdMs) => {
    const r = (await send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('.output[data-out="A"] ${sel}').getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`, returnByValue: true,
    }, sessionId)).result.result.value;
    const base = { x: r.x, y: r.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
    await sleep(holdMs);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
    await sleep(200);
  };
  const check = (label, ok, detail) => console.log(`LOAD nudge ${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  const vol0 = Number(await valueOf('.volume'));
  await press('.nudge[data-for="volume"][data-step="1"]', 50);
  const vol1 = Number(await valueOf('.volume'));
  check('VOL + once', vol1 === vol0 + 1, `${vol0} -> ${vol1}`);
  await press('.nudge[data-for="volume"][data-step="-1"]', 1000);
  const vol2 = Number(await valueOf('.volume'));
  check('VOL - hold 1s repeats', vol1 - vol2 >= 5, `${vol1} -> ${vol2}`);
  const label = (await send('Runtime.evaluate', {
    expression: `document.querySelector('.output[data-out="A"] .volumeVal').textContent`, returnByValue: true,
  }, sessionId)).result.result.value;
  check('VOL label follows', label.endsWith('dB'), label);
  const dly0 = Number(await valueOf('.delay'));
  await press('.nudge[data-for="delay"][data-step="-1"]', 50);
  check('DLY - at minimum stays', Number(await valueOf('.delay')) === Math.max(0, dly0 - 1), `${dly0} -> ${await valueOf('.delay')}`);
  await press('.nudge[data-for="delay"][data-step="1"]', 50);
  const saved = (await send('Runtime.evaluate', {
    expression: `chrome.storage.local.get('settings').then((s) => JSON.stringify(s.settings?.A))`, awaitPromise: true, returnByValue: true,
  }, sessionId)).result.result.value;
  check('settings persisted', saved.includes(`"delayMs":${Math.max(0, dly0 - 1) + 1}`), saved);
  console.log('LOAD popup errors:', JSON.stringify(errors));
  if (shotPath) {
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  }
} catch (err) {
  console.log('LOAD error:', err.message);
} finally {
  await send('Browser.close').catch(() => {});
  setTimeout(() => process.exit(0), 1000);
}
