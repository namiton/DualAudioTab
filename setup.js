// Copyright (c) 2026 Namiton
// SPDX-License-Identifier: GPL-3.0-only
'use strict';

document.getElementById('grant').addEventListener('click', async () => {
  const result = document.getElementById('result');
  result.hidden = false;
  try {
    // 権限付与のためだけに取得し、すぐ停止する
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    result.textContent = '許可された。このタブを閉じて、ツールバーのアイコンから設定する。';
    result.classList.remove('is-error');
  } catch (err) {
    result.textContent = `許可できなかった: ${err.message}`;
    result.classList.add('is-error');
  }
});
