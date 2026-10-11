// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
// 音の揺れ調査: 合成音を A/B に流し、報告遅延と自動補正値の変化を一定時間記録する
// 実行: node test/latency-watch.mjs <使い捨てプロファイルのパス> [秒数] [B デバイス名の一部]
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_DIR = path.resolve(import.meta.dirname, '..');
const [profile, secArg = '120', bHint = 'CABLE Input'] = process.argv.slice(2);
const DURATION_MS = Number(secArg) * 1000;
const SETTLE_MS = 3000;

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
const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
const evaluate = async (sessionId, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  return r.result?.exceptionDetails ? `EXCEPTION ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
};

try {
  const extId = (await send('Extensions.loadUnpacked', { path: EXT_DIR })).result.id;
  // デバイス ID 取得のためマイク権限を付与（実利用時の「許可する」相当）
  await send('Browser.grantPermissions', { origin: `chrome-extension://${extId}`, permissions: ['audioCapture'] });
  await sleep(1500);
  let targets = (await send('Target.getTargets')).result.targetInfos;
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  await evaluate(await attach(sw.targetId), 'ensureOffscreen()');
  await sleep(1000);
  targets = (await send('Target.getTargets')).result.targetInfos;
  const off = await attach(targets.find((t) => t.url.includes('offscreen.html')).targetId);

  const setup = await evaluate(off, `(async () => {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const b = devs.find((d) => d.label.includes(${JSON.stringify(bHint)}));
    const gen = new AudioContext();
    const osc = gen.createOscillator();
    const g = gen.createGain(); g.gain.value = 0.02;
    const dest = gen.createMediaStreamDestination();
    osc.connect(g).connect(dest); osc.start();
    window.__gen = gen;
    stream = dest.stream;
    outputs.forEach((o) => { o.stream = stream; });
    const s = (deviceId) => ({ deviceId, volume: 1, delayMs: 0, muted: false });
    await applySettings({ A: s('default'), B: s(b ? b.deviceId : 'off'), autoComp: true });
    // 補正値の変化（= DelayNode を動かした回数）を記録
    window.__log = [];
    const t0 = performance.now();
    outputs.forEach((o) => {
      const orig = o.setCompDelay.bind(o);
      o.setCompDelay = (ms) => {
        const before = o.compDelayMs;
        orig(ms);
        if (o.compDelayMs !== before) window.__log.push({ t: Math.round(performance.now() - t0), out: o.name, from: +before.toFixed(1), to: +o.compDelayMs.toFixed(1) });
      };
    });
    window.__samples = [];
    window.__sampler = setInterval(() => {
      window.__samples.push(outputs.map((o) => o.reportedLatencyMs));
    }, 200);
    return JSON.stringify({ A: 'default', B: b ? b.label : 'NOT FOUND', active: outputs.map((o) => o.active) });
  })()`);
  console.log('WATCH setup:', setup);

  await sleep(DURATION_MS);
  const result = await evaluate(off, `(() => {
    clearInterval(window.__sampler);
    const stat = (i) => {
      const v = window.__samples.map((s) => s[i]).filter((x) => x != null);
      const uniq = [...new Set(v.map((x) => x.toFixed(1)))];
      let jumps = 0;
      for (let k = 1; k < v.length; k++) if (Math.abs(v[k] - v[k - 1]) >= 2) jumps++;
      return { samples: v.length, min: Math.min(...v).toFixed(1), max: Math.max(...v).toFixed(1), distinct: uniq.slice(0, 12), jumpsOver2ms: jumps };
    };
    return JSON.stringify({ A: stat(0), B: stat(1), compChanges: window.__log });
  })()`);
  const r = JSON.parse(result);
  console.log('WATCH latency A:', JSON.stringify(r.A));
  console.log('WATCH latency B:', JSON.stringify(r.B));
  console.log(`WATCH comp delay changes (${r.compChanges.length}):`, JSON.stringify(r.compChanges.slice(0, 30)));
  // 再生中に DelayNode を動かすと音程が揺れる。計測完了後（開始 3 秒以降）は補正値が動かないこと
  const late = r.compChanges.filter((c) => c.t > SETTLE_MS);
  console.log(`WATCH ${late.length === 0 ? 'PASS' : 'FAIL'} no comp change after ${SETTLE_MS} ms: ${late.length} change(s)`);

  // 決定的な再現: B の報告遅延を 52/61ms で跳ねさせ、補正処理を 60 回（= 計測周期 60 回分）呼ぶ。
  // 最初の 20 回（計測期間）以降に補正値が動かないこと
  const sim = await evaluate(off, `(() => {
    outputs.forEach((o) => { o.compDelayMs = 0; o.latencySamples = []; });
    const seq = [52, 61, 52, 52, 61, 52, 52, 52, 61, 52];
    let tick = 0;
    Object.defineProperty(outputs[0], 'reportedLatencyMs', { configurable: true, get: () => 54 });
    Object.defineProperty(outputs[1], 'reportedLatencyMs', { configurable: true, get: () => seq[tick % seq.length] });
    const changes = [];
    for (tick = 0; tick < 60; tick++) {
      const before = outputs.map((o) => o.compDelayMs);
      updateCompensation(outputs, true);
      outputs.forEach((o, i) => { if (o.compDelayMs !== before[i]) changes.push({ tick, out: o.name, to: +o.compDelayMs.toFixed(1) }); });
    }
    return JSON.stringify(changes);
  })()`);
  const simChanges = JSON.parse(sim);
  const simLate = simChanges.filter((c) => c.tick >= 20);
  console.log(`WATCH SIM ${simLate.length === 0 ? 'PASS' : 'FAIL'} fluctuating latency: ${simLate.length} change(s) after settle`, JSON.stringify(simChanges.slice(0, 8)));
} catch (err) {
  console.log('WATCH error:', err.message);
} finally {
  await send('Browser.close').catch(() => {});
  setTimeout(() => process.exit(0), 1000);
}
