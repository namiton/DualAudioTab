'use strict';

const $ = (id) => document.getElementById(id);
const OUTPUT_OFF = 'off';
const METER_FLOOR_DB = -60;
const NAMES = ['A', 'B'];

let settings;
let currentTab;
let capturedTabId = null;
const views = {};

const toOffscreen = (type, extra = {}) =>
  chrome.runtime.sendMessage({ target: 'offscreen', type, ...extra }).catch(() => null);
const toBackground = (type, extra = {}) =>
  chrome.runtime.sendMessage({ target: 'background', type, ...extra });

function formatGainDb(gain) {
  if (gain <= 0) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

async function persist() {
  await saveSettings(settings);
  if (capturedTabId != null) await toOffscreen('settings', { settings });
}

const NUDGE_REPEAT_DELAY_MS = 400;
const NUDGE_REPEAT_INTERVAL_MS = 60;

// +/- ボタン: スライダーを 1 ステップ動かし、既存の input ハンドラで反映。長押しで連続
function bindNudge(btn, input) {
  const step = Number(btn.dataset.step);
  let timer = null;
  const apply = () => {
    const before = input.value;
    input.value = Number(input.value) + step;
    if (input.value !== before) input.dispatchEvent(new Event('input'));
  };
  const stopRepeat = () => {
    clearTimeout(timer);
    timer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    btn.setPointerCapture(e.pointerId);
    apply();
    const repeat = (delay) => {
      timer = setTimeout(() => {
        apply();
        repeat(NUDGE_REPEAT_INTERVAL_MS);
      }, delay);
    };
    repeat(NUDGE_REPEAT_DELAY_MS);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, stopRepeat);
  // キーボード操作（Enter / Space）は click のみ発生する（detail === 0）
  btn.addEventListener('click', (e) => {
    if (e.detail === 0) apply();
  });
}

function buildOutputView(name) {
  const section = document.querySelector(`.output[data-out="${name}"]`);
  section.appendChild($('outputTemplate').content.cloneNode(true));
  const q = (sel) => section.querySelector(sel);
  const v = {
    section,
    device: q('.device'),
    volume: q('.volume'),
    volumeVal: q('.volumeVal'),
    delay: q('.delay'),
    delayVal: q('.delayVal'),
    mute: q('.mute'),
    meter: q('.meter-fill'),
    latency: q('.latency'),
    error: q('.error'),
    level: 0,
  };
  q('.ch-badge').textContent = name;
  const s = () => settings[name];

  const render = () => {
    v.volume.value = Math.round(s().volume * 100);
    v.volumeVal.textContent = formatGainDb(s().volume);
    v.delay.value = s().delayMs;
    v.delayVal.textContent = `${s().delayMs} ms`;
    v.mute.setAttribute('aria-pressed', String(s().muted));
    section.classList.toggle('is-off', s().deviceId === OUTPUT_OFF);
  };
  v.render = render;

  v.device.addEventListener('change', () => {
    s().deviceId = v.device.value;
    render();
    persist();
  });
  v.volume.addEventListener('input', () => {
    s().volume = v.volume.value / 100;
    render();
    persist();
  });
  // ダブルクリックで 0 dB に戻す
  v.volume.addEventListener('dblclick', () => {
    s().volume = 1;
    render();
    persist();
  });
  v.delay.addEventListener('input', () => {
    s().delayMs = Number(v.delay.value);
    render();
    persist();
  });
  section.querySelectorAll('.nudge').forEach((btn) => bindNudge(btn, v[btn.dataset.for]));
  v.mute.addEventListener('click', () => {
    s().muted = !s().muted;
    render();
    persist();
  });
  views[name] = v;
  render();
}

async function refreshDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  // ラベルが空 = マイク権限未付与。デバイス ID も既定以外は取れない
  const hasLabels = devices.some((d) => d.label);
  $('permission').hidden = hasLabels;
  for (const name of NAMES) {
    const sel = views[name].device;
    const current = settings[name].deviceId;
    sel.replaceChildren(new Option('オフ', OUTPUT_OFF));
    // 権限が無いと ID 空のエントリしか返らない。既定のデバイスだけは選べるようにする
    if (!devices.some((d) => d.deviceId === 'default')) sel.add(new Option('既定のデバイス', 'default'));
    for (const d of devices.filter((x) => x.deviceId)) {
      const label = d.deviceId === 'default'
        ? `既定: ${d.label.replace(/^既定 - |^Default - /, '') || '既定のデバイス'}`
        : (d.label || `デバイス ${d.deviceId.slice(0, 8)}`);
      sel.add(new Option(label, d.deviceId));
    }
    if (![...sel.options].some((o) => o.value === current)) {
      sel.add(new Option('（未接続のデバイス）', current));
    }
    sel.value = current;
  }
}

function renderCaptureState() {
  const here = capturedTabId != null && capturedTabId === currentTab?.id;
  const elsewhere = capturedTabId != null && !here;
  $('startStop').textContent = here ? '停止' : (elsewhere ? 'このタブに切替' : '開始');
  $('startStop').classList.toggle('active', here);
  $('led').classList.toggle('on', here);
  $('statusText').textContent = here ? 'CAPTURE LIVE' : (elsewhere ? 'CAPTURE 別タブ' : 'IDLE');
  showNotice(elsewhere ? '別のタブを取り込み中。切替でこのタブに移る。' : '');
}

function showNotice(text, isError = false) {
  const n = $('notice');
  n.hidden = !text;
  n.textContent = text;
  n.classList.toggle('is-error', isError);
}

async function startStop() {
  const here = capturedTabId != null && capturedTabId === currentTab?.id;
  $('startStop').disabled = true;
  try {
    if (here) {
      await toBackground('stop');
      capturedTabId = null;
    } else {
      // ポップアップ表示（拡張の呼び出し）中のみ取得できる
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTab.id });
      const res = await toBackground('start', { streamId, tabId: currentTab.id, settings });
      if (res?.error) throw new Error(res.error);
      // 応答が無い・取り込み中でない場合も失敗として扱う（無応答を成功扱いしない）
      if (!res?.capturing) throw new Error('取り込みが開始されなかった');
      capturedTabId = currentTab.id;
    }
    renderCaptureState();
  } catch (err) {
    showNotice(`開始できない: ${err.message}`, true);
  } finally {
    $('startStop').disabled = false;
  }
}

async function pollStatus() {
  if (capturedTabId != null) {
    const st = await toOffscreen('status');
    for (const o of st?.outputs || []) {
      const v = views[o.name];
      const db = o.peak > 0 ? 20 * Math.log10(o.peak) : METER_FLOOR_DB;
      const target = Math.max(0, Math.min(1, 1 - db / METER_FLOOR_DB));
      v.level = Math.max(target, v.level - 0.04);
      v.meter.style.clipPath = `inset(0 ${((1 - v.level) * 100).toFixed(1)}% 0 0)`;
      v.latency.textContent = o.latencyMs == null
        ? 'LAT --'
        : `LAT ${o.latencyMs.toFixed(1)} ms${o.compMs >= 0.5 ? `  COMP +${o.compMs.toFixed(1)} ms` : ''}`;
      v.error.textContent = o.error || '';
    }
  }
  setTimeout(pollStatus, 66);
}

async function init() {
  settings = await loadSettings();
  NAMES.forEach(buildOutputView);
  $('autoComp').checked = settings.autoComp;
  $('autoComp').addEventListener('change', () => {
    settings.autoComp = $('autoComp').checked;
    persist();
  });
  $('startStop').addEventListener('click', startStop);
  $('permission').addEventListener('click', () => chrome.tabs.create({ url: 'setup.html' }));

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('tabTitle').textContent = currentTab?.title || currentTab?.url || '—';
  capturedTabId = (await toBackground('capturedTab')).tabId;
  renderCaptureState();
  await refreshDevices();
  pollStatus();
}

init();
