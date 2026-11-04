/*
 * 手机签到页脚本
 * - 手写签名：Canvas 指针绘制，支持撤回/清空；导出透明底 PNG
 * - 提交：POST /api/signin，成功后生成「入校通行证」并允许保存为 PNG
 * - 同一设备用本地 client 标识，服务端据此做 5 秒防抖（手滑重复提交不会重复上墙）
 */
(function () {
  'use strict';

  var form = document.getElementById('form');
  var nameEl = document.getElementById('name');
  var pad = document.getElementById('pad');
  var canvas = document.getElementById('sig');
  var errEl = document.getElementById('err');
  var submitBtn = document.getElementById('submit');
  var passEl = document.getElementById('pass');
  var passCanvas = document.getElementById('passCanvas');
  var passImg = document.getElementById('passImg');
  var saveBtn = document.getElementById('save');
  var saveHint = document.getElementById('saveHint');
  var IS_WECHAT = /MicroMessenger/i.test(navigator.userAgent);
  var ctx = canvas.getContext('2d');

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var strokes = [];     // 每笔是一串点，撤回按笔删
  var drawing = null;

  /* ================= 手写板 ================= */

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
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 1.3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#0B1E45';
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < pts.length - 1; k++) {
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
  window.addEventListener('orientationchange', function () { setTimeout(resize, 260); });
  resize();

  /* ================= 本机标识 ================= */

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

  function showErr(msg) { errEl.textContent = msg || ''; }

  /* ================= 提交 ================= */

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

    var sigData = strokes.length ? canvas.toDataURL('image/png') : '';
    var body = {
      name: name,
      unit: document.getElementById('unit').value.trim(),
      type: document.getElementById('type').value,
      group: document.getElementById('group').value.trim(),
      route: document.getElementById('route').value.trim(),
      client: clientId(),
      sig: sigData
    };

    fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        // 网关/代理出错时会返回 HTML 错误页，不能直接 .json()，否则用户只会看到
        // “Unexpected token '<'” 这种看不懂的报错
        return r.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (err) {}

          if (!r.ok || !data) {
            if (r.status === 429) throw new Error('提交太频繁了，歇一会儿再试');
            if (r.status === 413) throw new Error('签名图太大了，少写几笔再试');
            if (r.status === 404) throw new Error('签到服务地址变了，请重新扫码');
            if (!data) throw new Error('服务暂时不可用（' + r.status + '），请稍后重试');
            throw new Error(data.detail || '提交失败');
          }
          return data;
        });
      })
      .then(function (res) {
        form.hidden = true;
        passEl.hidden = false;
        passEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return renderCard(res.item, sigData);
      })
      .catch(function (err) {
        var m = err && err.message;
        showErr(m === 'Failed to fetch' ? '网络不通，请连上网络后重试' : (m || '提交失败'));
        submitBtn.disabled = false;
        submitBtn.textContent = '提交签到';
      });
  });

  /* ================= 入校通行证 ================= */

  var W = 750, H = 1180;
  var emblem = new Image();
  var emblemReady = false;
  emblem.onload = function () { emblemReady = true; };
  emblem.src = 'img/emblem.png';

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // 签名画布四周有大片空白，先按笔迹裁边，否则贴到牌上会显得很小
  function trimCanvas(src) {
    var w = src.width, h = src.height;
    var d = src.getContext('2d').getImageData(0, 0, w, h).data;
    var top = -1, bottom = -1, left = w, right = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 20) {
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (top < 0) return null;
    var pad = 10;
    left = Math.max(0, left - pad);
    top = Math.max(0, top - pad);
    right = Math.min(w - 1, right + pad);
    bottom = Math.min(h - 1, bottom + pad);
    var c = document.createElement('canvas');
    c.width = right - left + 1;
    c.height = bottom - top + 1;
    c.getContext('2d').drawImage(src, -left, -top);
    return c;
  }

  // 透明底的深色笔迹在深蓝底上看不见，染成金色再画
  function tintGold(img, maxW, maxH) {
    var r = Math.min(maxW / img.width, maxH / img.height, 2.2);
    var w = Math.max(1, Math.round(img.width * r));
    var h = Math.max(1, Math.round(img.height * r));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    g.globalCompositeOperation = 'source-in';
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#FFF1C6');
    grad.addColorStop(1, '#E8B75A');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    return c;
  }

  function fitName(g, text, maxW, base) {
    var size = base;
    g.font = '700 ' + size + 'px "Noto Serif SC", "Songti SC", serif';
    while (g.measureText(text).width > maxW && size > 26) {
      size -= 2;
      g.font = '700 ' + size + 'px "Noto Serif SC", "Songti SC", serif';
    }
    return size;
  }

  function drawQr(g, text, x, y, size) {
    g.fillStyle = '#FFFFFF';
    roundRect(g, x, y, size, size, 10);
    g.fill();

    if (typeof window.qrcode !== 'function') {
      g.fillStyle = '#8A97AD';
      g.font = '16px sans-serif';
      g.textAlign = 'center';
      g.fillText('二维码不可用', x + size / 2, y + size / 2);
      return;
    }
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var pad = 12;
    var cell = (size - pad * 2) / n;
    g.fillStyle = '#0B1E45';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          g.fillRect(x + pad + c * cell, y + pad + r * cell, cell + 0.4, cell + 0.4);
        }
      }
    }
  }

  function dateText(ts) {
    var d = new Date(ts || Date.now());
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function renderCard(item, sigDataUrl) {
    return new Promise(function (resolve) {
      var g = passCanvas.getContext('2d');

      var go = function () {
        paint(g, item, sigDataUrl);
        // 微信的长按「保存图片」只认 <img>，对页面上的 <canvas> 经常不弹菜单：
        // 画完立刻转成真图片顶上去，canvas 退到后台只当绘制底板（保存逻辑仍从它导出）
        passImg.src = passCanvas.toDataURL('image/png');
        passCanvas.hidden = true;
        passImg.hidden = false;
        if (IS_WECHAT) saveBtn.textContent = '微信内请长按上方图片保存';
        resolve();
      };
      if (emblemReady) return go();

      // 校徽没加载完就等它，最多 1.5 秒，不能让用户卡在空白
      var waited = 0;
      var timer = setInterval(function () {
        waited += 100;
        if (emblemReady || waited > 1500) { clearInterval(timer); go(); }
      }, 100);
    });
  }

  function paint(g, item, sigDataUrl) {
    g.clearRect(0, 0, W, H);

    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#12305F');
    bg.addColorStop(0.45, '#0B1E45');
    bg.addColorStop(1, '#071431');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    var glow = g.createRadialGradient(W / 2, 40, 20, W / 2, 40, 520);
    glow.addColorStop(0, 'rgba(227,178,90,0.20)');
    glow.addColorStop(1, 'rgba(227,178,90,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, 620);

    // 双层金色边框
    g.strokeStyle = 'rgba(227,178,90,0.55)';
    g.lineWidth = 2;
    roundRect(g, 26, 26, W - 52, H - 52, 26);
    g.stroke();
    g.strokeStyle = 'rgba(227,178,90,0.16)';
    g.lineWidth = 1;
    roundRect(g, 38, 38, W - 76, H - 76, 20);
    g.stroke();

    // 校徽
    g.fillStyle = '#FFFFFF';
    roundRect(g, 62, 66, 128, 92, 12);
    g.fill();
    if (emblemReady) {
      var er = Math.min((128 - 20) / emblem.width, (92 - 16) / emblem.height);
      var ew = emblem.width * er, eh = emblem.height * er;
      g.drawImage(emblem, 62 + (128 - ew) / 2, 66 + (92 - eh) / 2, ew, eh);
    }

    // 校名与标题
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(227,178,90,0.95)';
    g.font = '500 23px "Noto Serif SC", "Songti SC", serif';
    g.fillText('江苏省无锡师范附属小学', 214, 100);

    g.fillStyle = '#FFF6E2';
    g.font = '700 44px "Noto Serif SC", "Songti SC", serif';
    g.fillText('入 校 通 行 证', 214, 152);

    g.fillStyle = 'rgba(227,178,90,0.45)';
    g.font = '500 12px "Helvetica Neue", Arial, sans-serif';
    g.fillText('A D M I S S I O N   P A S S', 216, 178);

    var line = g.createLinearGradient(62, 0, W - 62, 0);
    line.addColorStop(0, 'rgba(227,178,90,0)');
    line.addColorStop(0.5, 'rgba(227,178,90,0.55)');
    line.addColorStop(1, 'rgba(227,178,90,0)');
    g.fillStyle = line;
    g.fillRect(62, 214, W - 124, 1.5);

    // 昵称
    var name = item.name || '来宾';
    g.textAlign = 'center';
    g.fillStyle = '#FFFFFF';
    fitName(g, name, 560, 66);
    g.fillText(name, W / 2, 310);

    // 签名（染金后叠加；图片是异步解码的，画完再补下半部分）
    if (sigDataUrl) {
      var sImg = new Image();
      sImg.onload = function () {
        var hadSig = false;
        try {
          // trimCanvas 需要画布，先把签名图画进一张离屏画布再裁边
          var box = document.createElement('canvas');
          box.width = sImg.naturalWidth || sImg.width;
          box.height = sImg.naturalHeight || sImg.height;
          box.getContext('2d').drawImage(sImg, 0, 0);
          var src = trimCanvas(box) || box;
          var tinted = tintGold(src, 540, 210);
          g.drawImage(tinted, (W - tinted.width) / 2, 356 + (210 - tinted.height) / 2);
          hadSig = true;
        } catch (err) {
          hadSig = false;
        }
        paintRest(g, item, hadSig);
      };
      sImg.onerror = function () { paintRest(g, item, false); };
      sImg.src = sigDataUrl;
    } else {
      g.fillStyle = 'rgba(238,244,255,0.45)';
      g.font = '400 22px "Noto Serif SC", "Songti SC", serif';
      g.fillText('（未签名，凭昵称与编号核验）', W / 2, 440);
      paintRest(g, item, false);
    }
  }

  function paintRest(g, item, hadSig) {
    var rows = [
      ['单位', item.unit],
      ['来访类型', item.type],
      ['分组', item.group],
      ['参观路线', item.route]
    ].filter(function (r) { return r[1]; });

    var y = hadSig ? 620 : 540;
    if (rows.length) {
      g.textAlign = 'left';
      for (var i = 0; i < rows.length; i++) {
        g.fillStyle = 'rgba(227,178,90,0.62)';
        g.font = '400 22px "Noto Serif SC", "Songti SC", serif';
        g.fillText(rows[i][0], 90, y);

        var v = String(rows[i][1]);
        g.fillStyle = '#E8EEFB';
        g.font = '500 25px "Noto Serif SC", "Songti SC", serif';
        while (g.measureText(v).width > 410 && v.length > 4) v = v.slice(0, v.length - 2) + '…';
        g.fillText(v, 230, y);
        y += 52;
      }
    } else {
      g.textAlign = 'center';
      g.fillStyle = 'rgba(238,244,255,0.42)';
      g.font = '400 22px "Noto Serif SC", "Songti SC", serif';
      g.fillText('参观嘉宾', W / 2, y + 20);
    }

    var line = g.createLinearGradient(62, 0, W - 62, 0);
    line.addColorStop(0, 'rgba(227,178,90,0)');
    line.addColorStop(0.5, 'rgba(227,178,90,0.45)');
    line.addColorStop(1, 'rgba(227,178,90,0)');
    g.fillStyle = line;
    g.fillRect(62, 872, W - 124, 1.5);

    // 二维码：指向这张牌的核验页
    drawQr(g, location.origin + '/card/' + item.id, 62, 902, 186);

    g.textAlign = 'left';
    g.fillStyle = 'rgba(227,178,90,0.62)';
    g.font = '400 20px "Noto Serif SC", "Songti SC", serif';
    g.fillText('有效期', 296, 948);

    g.fillStyle = '#FFFFFF';
    g.font = '500 27px "Noto Serif SC", "Songti SC", serif';
    g.fillText(dateText(item.ts) + ' 当日有效', 296, 988);

    g.fillStyle = 'rgba(227,178,90,0.62)';
    g.font = '400 20px "Noto Serif SC", "Songti SC", serif';
    g.fillText('编号', 296, 1042);

    g.fillStyle = '#E8EEFB';
    g.font = '500 24px "Helvetica Neue", Arial, sans-serif';
    g.fillText('NO. ' + String(item.id).slice(0, 8).toUpperCase(), 296, 1076);

    g.textAlign = 'center';
    g.fillStyle = 'rgba(238,244,255,0.38)';
    g.font = '400 18px "Noto Serif SC", "Songti SC", serif';
    g.fillText('凭此牌在校内参观 · 离校自动失效', W / 2, 1120);
  }

  /* ================= 保存 ================= */

  /* ================= 预览：?demo=1 自动填样例并提交 ================= */
  /* 用来快速看通行证长什么样，不用每次手写；正式入口不受影响 */
  if (/[?&]demo=1/.test(location.search)) {
    nameEl.value = '张老师';
    document.getElementById('unit').value = '无锡市教育局';
    document.getElementById('type').value = '领导';
    document.getElementById('group').value = '第一组';
    document.getElementById('route').value = 'A 线';

    // 画两笔示意签名
    var w = canvas.width, h = canvas.height;
    strokes = [
      [{ x: w * 0.18, y: h * 0.62 }, { x: w * 0.3, y: h * 0.34 }, { x: w * 0.42, y: h * 0.58 }, { x: w * 0.52, y: h * 0.36 }],
      [{ x: w * 0.56, y: h * 0.5 }, { x: w * 0.68, y: h * 0.66 }, { x: w * 0.8, y: h * 0.4 }]
    ];
    pad.classList.add('dirty');
    redraw();

    setTimeout(function () { form.requestSubmit(); }, 120);
  }

  saveBtn.addEventListener('click', function () {
    var name = (nameEl.value || '来宾').trim();
    saveHint.textContent = '';
    // 微信 WebView 会拦截 <a download> 弹「不给下载」，别去碰它，直接引导长按
    if (IS_WECHAT) {
      saveHint.textContent = '微信会拦截下载：请长按上方通行证图片，选择「保存图片」';
      return;
    }
    if (!passCanvas.toBlob) {
      saveHint.textContent = '这个浏览器不支持直接保存，请长按图片选择「保存图片」';
      return;
    }
    passCanvas.toBlob(function (blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '入校通行证-' + name + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      saveHint.textContent = '已保存。若手机没反应，长按上面的图片选择「保存图片」';
    }, 'image/png');
  });
})();
