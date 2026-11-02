/*
 * 大屏端脚本（纯前端静态版）
 * - 舞台等比缩放：设计稿 1280×722，铺满任意屏幕且不变形
 * - 二维码：本地 qrcode-generator 生成，离线可用
 * - 签到人数：先读 URL 参数 / 本机计数，后端接入后替换 setCount 的数据来源
 * - 调试：URL 加 ?debug=1，按 O 叠原型、按 D 差值对比
 */
(function () {
  'use strict';

  var DESIGN_W = 1280;
  var DESIGN_H = 722;

  var stage = document.getElementById('stage');
  var params = new URLSearchParams(location.search);
  var debug = params.get('debug') === '1';

  /* ---------- 等比缩放 ---------- */
  function fit() {
    var s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    stage.style.transform = 'scale(' + s + ')';
    var label = document.getElementById('dbg-scale');
    if (label) label.textContent = s.toFixed(3);
  }
  window.addEventListener('resize', fit);
  fit();

  /* ---------- 二维码 ---------- */
  function phoneUrl() {
    var custom = params.get('qr');
    if (custom) return custom;
    return new URL('../../phone/', location.href).toString();
  }

  function drawQr(text) {
    var canvas = document.getElementById('qr');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var size = canvas.width;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    if (typeof window.qrcode !== 'function') {
      ctx.fillStyle = '#8A97AD';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('二维码加载失败', size / 2, size / 2);
      return;
    }

    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var cell = Math.floor(size / n);
    var offset = Math.floor((size - cell * n) / 2);
    ctx.fillStyle = '#0B1E45';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
      }
    }
  }

  drawQr(phoneUrl());

  /* ---------- 签到人数 ---------- */
  var countEl = document.getElementById('count');

  function setCount(n) {
    var v = Math.max(0, Math.floor(Number(n) || 0));
    countEl.textContent = String(v);
  }

  var initial = params.get('count');
  setCount(initial !== null ? initial : 0);

  window.Screen = { setCount: setCount, drawQr: drawQr };

  /* ---------- 调试叠图 ---------- */
  if (debug) {
    document.body.classList.add('debug');
    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if (k === 'o') {
        document.body.classList.remove('overlay-diff');
        document.body.classList.toggle('show-overlay');
      } else if (k === 'd') {
        document.body.classList.remove('show-overlay');
        document.body.classList.toggle('overlay-diff');
      }
    });
  }
})();
