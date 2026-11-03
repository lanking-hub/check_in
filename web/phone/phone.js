/*
 * 手机签到页脚本
 * - 手写签名：Canvas 指针绘制，支持撤回/清空；导出透明底 PNG
 * - 提交：POST /api/signin，同一设备用本地 client 标识，重复提交是“改自己的记录”，不会重复上墙
 * 说明：这是联调用的最简版，等手机端原型出来整体替换样式，接口不用动。
 */
(function () {
  'use strict';

  var form = document.getElementById('form');
  var nameEl = document.getElementById('name');
  var pad = document.getElementById('pad');
  var canvas = document.getElementById('sig');
  var errEl = document.getElementById('err');
  var submitBtn = document.getElementById('submit');
  var doneEl = document.getElementById('done');
  var ctx = canvas.getContext('2d');

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var strokes = [];     // 每笔是一串点，撤回按笔删
  var drawing = null;

  /* ---------- 画布尺寸 ---------- */
  function resize() {
    var r = pad.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    redraw();
  }

  function toPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0B1E45';
    ctx.lineWidth = 2.6 * dpr;
    for (var i = 0; i < strokes.length; i++) {
      var pts = strokes[i];
      if (pts.length < 2) {
        // 单点也要能看到，画一个小圆点
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 1.3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#0B1E45';
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < pts.length - 1; k++) {
        // 用二次贝塞尔把折线圆滑成笔迹
        var mx = (pts[k].x + pts[k + 1].x) / 2;
        var my = (pts[k].y + pts[k + 1].y) / 2;
        ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
    }
  }

  pad.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = [toPoint(e)];
    strokes.push(drawing);
    pad.classList.add('dirty');
  });

  pad.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    e.preventDefault();
    drawing.push(toPoint(e));
    redraw();
  });

  function endStroke(e) {
    if (!drawing) return;
    if (drawing.length < 2) drawing.push({ x: drawing[0].x + 0.6, y: drawing[0].y + 0.6 });
    drawing = null;
    if (e && e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    redraw();
  }
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  document.getElementById('undo').addEventListener('click', function () {
    strokes.pop();
    if (!strokes.length) pad.classList.remove('dirty');
    redraw();
  });

  document.getElementById('clear').addEventListener('click', function () {
    strokes = [];
    pad.classList.remove('dirty');
    redraw();
  });

  window.addEventListener('resize', resize);
  // 手机旋转后宽高会变，等一下布局再量
  window.addEventListener('orientationchange', function () { setTimeout(resize, 260); });
  resize();

  /* ---------- 本机标识：用来识别“还是这个人” ---------- */
  function clientId() {
    try {
      var id = localStorage.getItem('checkin.client');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('checkin.client', id);
      }
      return id;
    } catch (e) {
      return '';
    }
  }

  function showErr(msg) {
    errEl.textContent = msg || '';
  }

  /* ---------- 提交 ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameEl.value.trim();
    if (!name) {
      showErr('请先填写称呼');
      nameEl.focus();
      return;
    }
    showErr('');
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';

    var body = {
      name: name,
      client: clientId(),
      sig: strokes.length ? canvas.toDataURL('image/png') : ''
    };

    fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.detail || '提交失败');
          return d;
        });
      })
      .then(function () {
        form.hidden = true;
        doneEl.hidden = false;
      })
      .catch(function (err) {
        showErr(err.message === 'Failed to fetch' ? '网络不通，请连上网络后重试' : err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = '提交签到';
      });
  });

  document.getElementById('again').addEventListener('click', function () {
    doneEl.hidden = true;
    form.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = '提交签到';
  });
})();
