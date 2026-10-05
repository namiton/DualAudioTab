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
