// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// icons/src の SVG を指定サイズの PNG（透過）に書き出す
// 実行: node tools/render-icons.mjs <使い捨てプロファイルのパス>
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(import.meta.dirname, '..');
const JOBS = [
  { src: 'icons/src/icon-on-small.svg', sizes: [16, 32], out: (s) => `icons/icon-on-${s}.png` },
];
const [profile] = process.argv.slice(2);

const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
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

try {
  const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  for (const job of JOBS) {
    const svg = readFileSync(path.join(ROOT, job.src), 'utf8');
    for (const size of job.sizes) {
      const html = `<html><body style="margin:0;background:transparent"><img id="i" width="${size}" height="${size}"
        src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
      await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` }, sessionId);
      await new Promise((r) => setTimeout(r, 300));
      const shot = await send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      }, sessionId);
      writeFileSync(path.join(ROOT, job.out(size)), Buffer.from(shot.result.data, 'base64'));
      console.log('written', job.out(size));
    }
  }
} finally {
  await send('Browser.close').catch(() => {});
  setTimeout(() => process.exit(0), 500);
}
