// 1 つの MediaStream を出力デバイスごとの AudioContext へ流す（DualAudioBrowser の audio.js から移植）
'use strict';

const OUTPUT_OFF = 'off';
const MAX_DELAY_SEC = 1.0;

class AudioOutput {
  constructor(name) {
    this.name = name;
    this.deviceId = OUTPUT_OFF;
    this.volume = 1;
    this.userDelayMs = 0;
    this.compDelayMs = 0;
    this.muted = false;
    this.ctx = null;
    this.nodes = null;
    this.stream = null;
    this.error = '';
  }

  get active() {
    return !!this.ctx;
  }

  // デバイス側が報告する遅延（ms）。未起動時は null
  get reportedLatencyMs() {
    if (!this.ctx) return null;
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  async setDevice(deviceId) {
    if (deviceId === this.deviceId && (this.ctx || deviceId === OUTPUT_OFF)) return;
    this.deviceId = deviceId;
    await this.rebuild();
  }

  async attach(stream) {
    this.stream = stream;
    await this.rebuild();
  }

  async rebuild() {
    await this.close();
    if (this.deviceId === OUTPUT_OFF || !this.stream) return;
    try {
      // sinkId '' は既定のデバイス
      const sinkId = this.deviceId === 'default' ? '' : this.deviceId;
      const ctx = new AudioContext({ latencyHint: 'interactive', sinkId });
      const source = ctx.createMediaStreamSource(this.stream);
      const delay = ctx.createDelay(MAX_DELAY_SEC);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(delay).connect(gain).connect(ctx.destination);
      gain.connect(analyser);
      this.ctx = ctx;
      this.nodes = { delay, gain, analyser, buf: new Float32Array(analyser.fftSize) };
      this.applyGain(true);
      this.applyDelay(true);
      if (ctx.state !== 'running') await ctx.resume();
      this.error = '';
    } catch (err) {
      await this.close();
      this.error = `出力を開けない: ${err.message}`;
    }
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.nodes = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  applySettings({ volume, delayMs, muted }) {
    this.volume = volume;
    this.userDelayMs = delayMs;
    this.muted = muted;
    this.applyGain(false);
    this.applyDelay(false);
  }

  setCompDelay(ms) {
    // 報告値は ±1ms 程度揺れる。都度動かすとピッチ揺れになるため小変化は無視
    if (Math.abs(ms - this.compDelayMs) < 2) return;
    this.compDelayMs = ms;
    this.applyDelay(false);
  }

  applyGain(immediate) {
    if (!this.nodes) return;
    const target = this.muted ? 0 : this.volume;
    const p = this.nodes.gain.gain;
    if (immediate) p.value = target;
    else p.setTargetAtTime(target, this.ctx.currentTime, 0.01);
  }

  applyDelay(immediate) {
    if (!this.nodes) return;
    const sec = Math.min(MAX_DELAY_SEC, Math.max(0, (this.userDelayMs + this.compDelayMs) / 1000));
    const p = this.nodes.delay.delayTime;
    if (immediate) p.value = sec;
    else p.setTargetAtTime(sec, this.ctx.currentTime, 0.02);
  }

  // 0..1 のピークレベル
  peak() {
    if (!this.nodes) return 0;
    const { analyser, buf } = this.nodes;
    analyser.getFloatTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > max) max = a;
    }
    return Math.min(1, max);
  }
}

// 報告遅延の差を DelayNode で揃える
function updateCompensation(outputs, autoComp) {
  const active = outputs.filter((o) => o.active);
  const maxLat = Math.max(0, ...active.map((o) => o.reportedLatencyMs));
  for (const out of outputs) {
    const l = out.reportedLatencyMs;
    out.setCompDelay(autoComp && l != null && active.length > 1 ? maxLat - l : 0);
  }
}
