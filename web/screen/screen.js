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

  // 用 http(s) 打开就自动接后端；file:// 直接双击打开或加 ?live=0 时，保持纯前端演示
  var live = (location.protocol === 'http:' || location.protocol === 'https:') && params.get('live') !== '0';

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

  // 有后端时用后端给的地址生成二维码：换部署地址不用改代码
  if (live && !params.get('qr')) {
    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) { if (cfg && cfg.phoneUrl) drawQr(cfg.phoneUrl); })
      .catch(function () {});
  }

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
    if (!live) fx.prefill(initial); // 纯前端模式：按 URL 里的人数先铺好沙粒
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

    if (live) startLive();
  }

  /* ---------- 接后端：拉全量 + WebSocket 订阅 ---------- */

  /**
   * 断线不影响已显示内容：页面不刷新，只把“已断开”角标亮出来，后台自动重连。
   * 重连成功后拉一次 /api/state 补齐断线期间漏掉的签到。
   */
  function startLive() {
    var badge = document.getElementById('net');
    var ws = null;
    var retry = 0;
    var lastMsg = 0;
    var timer = 0;

    function setOffline(on) {
      if (badge) badge.classList.toggle('show', on);
      document.body.classList.toggle('offline', on);
    }

    function sync() {
      fetch('/api/state')
        .then(function (r) { return r.json(); })
        .then(function (st) {
          setCount(st.count || 0, false);
          if (fx) { fx.reset(); fx.prefill(st.count || 0); }
        })
        .catch(function () {});
    }

    function onMessage(msg) {
      var d = msg.data;
      switch (msg.type) {
        case 'hello':
          // 首次连上或重连成功：以服务端数据为准重建画面
          sync();
          break;
        case 'signin':
          if (d && d.name) {
            fx.arrive({ name: d.name, sig: d.sig || '', silent: true });
            if (typeof msg.count === 'number') setCount(msg.count, true);
          }
          break;
        case 'remove':
          if (typeof msg.count === 'number') setCount(msg.count, true);
          break;
        case 'clear':
          fx.reset();
          setCount(0, false);
          break;
      }
    }

    function connect() {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws?role=screen');

      ws.onopen = function () {
        retry = 0;
        lastMsg = Date.now();
        setOffline(false);
      };
      ws.onmessage = function (ev) {
        lastMsg = Date.now();
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        onMessage(msg);
      };
      ws.onclose = function () {
        setOffline(true);
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(8000, 600 * Math.pow(1.8, retry)));
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }

    // 心跳：每 20 秒 ping 一次；超过 50 秒收不到任何消息就当作断线，主动重连
    setInterval(function () {
      if (ws && ws.readyState === 1) {
        try { ws.send('ping'); } catch (e) {}
        if (lastMsg && Date.now() - lastMsg > 50000) { try { ws.close(); } catch (e) {} }
      }
    }, 20000);

    connect();

    // 回到前台时如果连接已断，立刻重连，不用等退避计时
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && (!ws || ws.readyState > 1)) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
    });
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
