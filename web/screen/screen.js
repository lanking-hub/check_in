/*
 * 大屏端脚本（纯前端静态版）
 * - 舞台等比缩放：设计稿 1280×722，铺满任意屏幕且不变形
 * - 二维码：本地 qrcode-generator 生成，离线可用
 * - 签到人数：先读 URL 参数 / 本机计数，后端接入后替换 setCount 的数据来源
 * - 调试：URL 加 ?debug=1，按 O 叠原型、按 D 差值对比
 * - 彩排：按 S / 空格模拟 1 人签到，M 模拟 3 人同时签到；URL 加 ?demo=1 自动循环演示
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

  /* ---------- 签到人数（缓动计数，不跳变） ---------- */
  var countEl = document.getElementById('count');
  var countNow = 0;      // 当前显示值
  var countTarget = 0;   // 目标值
  var tweenFrom = 0, tweenStart = 0, tweenRaf = 0;
  var TWEEN_MS = 700;

  function renderCount(v) { countEl.textContent = String(Math.round(v)); }

  function tween(now) {
    var u = Math.min(1, (now - tweenStart) / TWEEN_MS);
    var e = 1 - Math.pow(1 - u, 3);
    countNow = tweenFrom + (countTarget - tweenFrom) * e;
    renderCount(countNow);
    tweenRaf = u < 1 ? requestAnimationFrame(tween) : 0;
  }

  function setCount(n, animate) {
    var v = Math.max(0, Math.floor(Number(n) || 0));
    countTarget = v;
    if (!animate) {
      cancelAnimationFrame(tweenRaf); tweenRaf = 0;
      countNow = v; renderCount(v);
      return;
    }
    tweenFrom = countNow;
    tweenStart = performance.now();
    if (!tweenRaf) tweenRaf = requestAnimationFrame(tween);
    // 数字轻微发光一下
    countEl.classList.remove('bump');
    void countEl.offsetWidth;
    countEl.classList.add('bump');
  }

  function addCount(d) { setCount(countTarget + (d || 1), true); }

  var initial = Number(params.get('count')) || 0;
  setCount(initial);

  window.Screen = { setCount: setCount, addCount: addCount, drawQr: drawQr };

  /* ---------- 签到特效 ---------- */
  var fx = window.SignFx;
  if (fx) {
    fx.prefill(initial); // 刷新后按已有人数铺好沙粒
    // 彩排：按 S 或空格模拟 1 人签到，按 M 模拟 3 人同时签到；?demo=1 自动循环演示
    window.addEventListener('keydown', function (e) {
      if (e.key === 's' || e.key === 'S' || e.key === ' ') { e.preventDefault(); fx.mock(1); }
      else if (e.key === 'm' || e.key === 'M') { fx.mock(3); }
    });
    // 调试：?fxsim=毫秒&n=人数  模拟签到并直接推演到该时刻（用于截图检查关键帧）
    var sim = params.get('fxsim');
    if (sim !== null) {
      fx.ready.then(function () {
        fx.mock(Number(params.get('n')) || 1);
        fx.simulate(Number(sim) || 0);
      });
    } else if (params.get('demo') === '1') {
      (function loop() {
        fx.mock(Math.random() < 0.35 ? 2 + ((Math.random() * 2) | 0) : 1);
        setTimeout(loop, 6000 + Math.random() * 4000);
      })();
    }
  }

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
