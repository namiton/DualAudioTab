// タブ音声の取り込みと A/B 出力。offscreen では chrome.runtime しか使えないため設定はメッセージで受け取る
'use strict';

const outputs = [new AudioOutput('A'), new AudioOutput('B')];
let stream = null;
let capturedTabId = null;
let autoComp = true;

async function applySettings(settings) {
  autoComp = settings.autoComp;
  await Promise.all(outputs.map(async (out) => {
    const s = settings[out.name];
    out.applySettings(s);
    await out.setDevice(s.deviceId);
  }));
  updateCompensation(outputs, autoComp);
}

async function start(streamId, tabId, settings) {
  await stop();
  // tabCapture の取り込み中はタブ側の再生が自動でミュートされ、A/B 経由でのみ鳴る
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  capturedTabId = tabId;
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'captureEnded', tabId });
  });
  outputs.forEach((o) => { o.stream = stream; });
  // 各出力はここでデバイスを開く（stream 設定後なので setDevice が rebuild する）
  await applySettings(settings);
}

async function stop() {
  await Promise.all(outputs.map((o) => o.close()));
  outputs.forEach((o) => { o.stream = null; });
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  capturedTabId = null;
}

function status() {
  return {
    capturing: !!stream,
    tabId: capturedTabId,
    outputs: outputs.map((o) => ({
      name: o.name,
      active: o.active,
      peak: o.peak(),
      latencyMs: o.reportedLatencyMs,
      compMs: o.compDelayMs,
      error: o.error,
    })),
  };
}

setInterval(() => updateCompensation(outputs, autoComp), 1000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  const run = {
    start: () => start(msg.streamId, msg.tabId, msg.settings).then(status),
    stop: () => stop().then(status),
    settings: () => applySettings(msg.settings).then(status),
    status: async () => status(),
  }[msg.type];
  if (!run) return false;
  run().then(sendResponse, (err) => sendResponse({ error: err.message, ...status() }));
  return true;
});
