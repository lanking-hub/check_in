/*
 * 大屏签到特效（Canvas 2D，无依赖）
 *
 * 一次签到的流程（约 7 秒，节奏放慢、柔和）：
 *   1. 名字浮现：手写体姓名（或手机上的手写签名）在书页上方的夜空中某个空位淡入，轻轻浮动
 *   2. 化作金沙：名字的笔画逐渐散成金色沙粒，名字随之慢慢变淡
 *   3. 缓缓流下：沙粒像细流一样带着轻微摆动缓慢飘落，汇入“乐学”字形并留下来
 *   4. 泛金光：大部分沙粒落定后，“乐学”柔和地泛一次金光
 * 多人同时签到：各自占用夜空里不同的位置独立播放，出场错开 0.9–1.7 秒、停留和散沙时长各自随机；
 *   位置都被占满时才排队。签到人数在收到签到时立即 +1，不等动画。
 *
 * 对外接口：window.SignFx
 *   arrive({ name, sig })  sig 可为空 / dataURL / Image / Canvas（透明底深色笔画）
 *   prefill(n)             页面刷新后按已签到人数直接铺好沙粒（无动画）
 *   mock(n)                随机模拟 n 次签到（彩排用）
 *   simulate(ms)           调试：停止实时循环并推演到第 ms 毫秒
 */
(function () {
  'use strict';

  var W = 1280;
  var H = 722;

  var canvas = document.getElementById('fx');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  /* ---------- 节奏参数（毫秒） ---------- */
  var T_APPEAR = 1000;        // 名字淡入
  var T_HOLD = [1800, 2900];  // 浮现开始到开始化沙（每人随机，避免同起同落）
  var T_SPAWN = [2000, 3000]; // 沙粒陆续散出的时间窗（每人随机）
  var START_GAP = [900, 1700];// 相邻两人出场的最小间隔：同时到达也错开出现
  var SLOT_COOLDOWN = 1500;   // 位置空出后先歇一会，避免新名字出现在上一位的落沙里
  var FLIGHT_MIN = 2600;      // 单颗沙粒飘落时长
  var FLIGHT_MAX = 3800;
  var FLASH_MS = 2400;        // 乐学泛金光
  var GRAINS_PER_PERSON = 360;

  var NAME_FONT = '"SignHand", "Kaiti SC", "STKaiti", "KaiTi", cursive';
  var NAME_SIZE = 40;

  // 夜空中名字可出现的位置（设计稿坐标，避开标题、左侧卡片和书页）
  var SLOTS = [
    { x: 430, y: 186 }, { x: 640, y: 172 }, { x: 852, y: 186 },
    { x: 372, y: 256 }, { x: 548, y: 250 }, { x: 740, y: 248 }, { x: 918, y: 258 }
  ];

  // 飞行中（夜空上，偏亮）与落定在米色书页上（需更深更饱和）的金色
  var GOLD = ['#FFF3CF', '#FFE29C', '#F8CD72', '#F0B856'];
  var SAND = ['#B8781C', '#C98A28', '#D89D36', '#E3AE48', '#A96C16'];

  /* ---------- 画布清晰度：跟随舞台缩放与 DPR ---------- */
  var k = 1;
  function resize() {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    k = Math.min(2.5, Math.max(1, s * (window.devicePixelRatio || 1)));
    canvas.width = Math.round(W * k);
    canvas.height = Math.round(H * k);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- 工具 ---------- */
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function radialSprite(stops) {
    var c = makeCanvas(32, 32), g = c.getContext('2d');
    var r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    stops.forEach(function (s) { r.addColorStop(s[0], s[1]); });
    g.fillStyle = r; g.fillRect(0, 0, 32, 32);
    return c;
  }
  // 夜空上用的亮光点（lighter 混合）；书页上用的深金光晕（米色纸面上 lighter 会看不见）
  var sprite = radialSprite([[0, 'rgba(255,248,225,1)'], [0.25, 'rgba(255,214,130,0.7)'], [1, 'rgba(255,190,90,0)']]);
  var goldSprite = radialSprite([[0, 'rgba(255,236,170,1)'], [0.3, 'rgba(226,160,50,0.65)'], [1, 'rgba(210,140,40,0)']]);

  /* ---------- 乐学字形：路径与落点池 ---------- */
  var glyphPath = new Path2D();
  var bbox = { x0: 376, y0: 392, x1: 897, y1: 603 };
  var glyphParts = [];
  ['glyph-le', 'glyph-xue'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    var p = new Path2D(el.getAttribute('d'));
    glyphPath.addPath(p);
    glyphParts.push(p);
  });

  // 字形内抖动网格采样，打乱后作为沙粒落点；名额用完后循环覆盖最早的沙粒
  var pool = [];
  (function buildPool() {
    // 探测画布需覆盖整个设计稿，否则 Chrome 对画布外的点一律返回 false
    var probe = makeCanvas(W, H).getContext('2d');
    var step = 2.6;
    for (var y = bbox.y0; y <= bbox.y1; y += step) {
      for (var x = bbox.x0; x <= bbox.x1; x += step) {
        var px = x + (Math.random() - 0.5) * step;
        var py = y + (Math.random() - 0.5) * step;
        for (var i = 0; i < glyphParts.length; i++) {
          if (probe.isPointInPath(glyphParts[i], px, py, 'evenodd')) { pool.push({ x: px, y: py }); break; }
        }
      }
    }
    shuffle(pool);
  })();
  var poolCursor = 0;
  var settled = new Array(pool.length); // settled[i] 对应 pool[i] 上的沙粒

  /* ---------- 名字（手写） ---------- */
  // 返回 ink（金色笔画，会被打散成沙）和 glow（柔光），尺寸为设计稿像素
  function buildName(item) {
    var w, h, ink, g;
    if (item.sigImage) {
      var im = item.sigImage;
      var iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
      var r = Math.min(200 / iw, 64 / ih);
      w = iw * r + 24; h = ih * r + 24;
      ink = makeCanvas(w * k, h * k); g = ink.getContext('2d');
      g.scale(k, k);
      g.drawImage(im, 12, 12, iw * r, ih * r);
      g.globalCompositeOperation = 'source-in'; // 把签名笔画染成金色
      var sg = g.createLinearGradient(0, 0, 0, h);
      sg.addColorStop(0, '#FFF1C6'); sg.addColorStop(1, '#F0BE60');
      g.fillStyle = sg; g.fillRect(0, 0, w, h);
    } else {
      var m = makeCanvas(10, 10).getContext('2d');
      m.font = NAME_SIZE + 'px ' + NAME_FONT;
      w = Math.min(260, m.measureText(item.name).width) + 24;
      h = NAME_SIZE * 1.5 + 12;
      ink = makeCanvas(w * k, h * k); g = ink.getContext('2d');
      g.scale(k, k);
      g.font = NAME_SIZE + 'px ' + NAME_FONT;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      var ng = g.createLinearGradient(0, h * 0.2, 0, h * 0.8);
      ng.addColorStop(0, '#FFF4D2'); ng.addColorStop(1, '#F2C468');
      g.fillStyle = ng;
      g.fillText(item.name, w / 2, h / 2, 236);
    }
    var glow = makeCanvas(w * k, h * k), gg = glow.getContext('2d');
    gg.shadowColor = 'rgba(255,196,90,0.95)';
    gg.shadowBlur = 14 * k;
    gg.drawImage(ink, 0, 0);
    gg.drawImage(ink, 0, 0);
    return { ink: ink, glow: glow, w: w, h: h };
  }

  // 从笔画像素中采样沙粒起点
  function sampleInk(ink, x0, y0, max) {
    var data = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height).data;
    var step = Math.max(1, Math.round(1.3 * k));
    var pts = [];
    for (var y = 0; y < ink.height; y += step) {
      for (var x = 0; x < ink.width; x += step) {
        if (data[(y * ink.width + x) * 4 + 3] > 120) pts.push({ x: x0 + x / k, y: y0 + y / k });
      }
    }
    shuffle(pts);
    return pts.slice(0, max);
  }

  /* ---------- 场景状态 ---------- */
  var queue = [];
  var active = [];
  var sparks = [];
  var slotBusy = SLOTS.map(function () { return false; });
  var slotFreeAt = SLOTS.map(function () { return 0; });
  var nextStartAt = 0;
  var pulses = [];            // 每人一次的金光脉冲

  // 空位中挑离“正在用的位置”最远的，名字长也不容易压到邻居；距离相近时随机
  function freeSlot(now) {
    var best = -1, bestScore = -1;
    for (var i = 0; i < SLOTS.length; i++) {
      if (slotBusy[i] || now < slotFreeAt[i]) continue;
      var d = 1e6;
      for (var j = 0; j < SLOTS.length; j++) {
        if (!slotBusy[j]) continue;
        var dx = SLOTS[i].x - SLOTS[j].x, dy = (SLOTS[i].y - SLOTS[j].y) * 2;
        d = Math.min(d, Math.sqrt(dx * dx + dy * dy));
      }
      var score = Math.min(d, 400) + rand(0, 120);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function arrive(rec) {
    if (!rec || !rec.name) return;
    var item = { name: String(rec.name).slice(0, 10) };
    // 人数以“收到签到”为准立即 +1；动画排队或错开不影响数字
    if (window.Screen && window.Screen.addCount) window.Screen.addCount(1);
    if (rec.sig && typeof rec.sig === 'string') {
      var im = new Image();
      im.onload = function () { item.sigImage = im; queue.push(item); };
      im.onerror = function () { queue.push(item); };
      im.src = rec.sig;
      return;
    }
    if (rec.sig) item.sigImage = rec.sig;
    queue.push(item);
  }

  function start(item, slot, now) {
    var n = buildName(item);
    var cx = SLOTS[slot].x + rand(-14, 14);
    var cy = SLOTS[slot].y + rand(-8, 8);
    var x0 = cx - n.w / 2, y0 = cy - n.h / 2;
    var src = sampleInk(n.ink, x0, y0, GRAINS_PER_PERSON);
    var tDis = now + rand(T_HOLD[0], T_HOLD[1]);
    var spawnWin = rand(T_SPAWN[0], T_SPAWN[1]);
    var parts = src.map(function (s) {
      var ti = poolCursor; poolCursor = (poolCursor + 1) % pool.length;
      var t = pool[ti];
      return {
        sx: s.x, sy: s.y, tx: t.x, ty: t.y, ti: ti,
        // 控制点偏向下方：先往下淌，再散开汇入字形，形成“细流”
        cx: s.x + (t.x - s.x) * 0.18 + rand(-36, 36),
        cy: s.y + (t.y - s.y) * rand(0.5, 0.75),
        sway: rand(3, 9), swf: rand(1, 2.2), ph: rand(0, 6.28),
        t0: tDis + Math.pow(Math.random(), 0.85) * spawnWin,
        dur: rand(FLIGHT_MIN, FLIGHT_MAX),
        color: pick(GOLD), size: rand(1.0, 1.8),
        px: s.x, py: s.y, done: false
      };
    });
    parts.sort(function (a, b) { return a.t0 - b.t0; });
    slotBusy[slot] = true;
    active.push({
      n: n, x0: x0, y0: y0, born: now, dissolve: tDis, slot: slot,
      parts: parts, spawned: 0, landed: 0, flashed: false, freed: false
    });
  }

  function settle(p, now) {
    settled[p.ti] = {
      x: p.tx, y: p.ty, color: pick(SAND), size: rand(1.4, 2.5),
      star: Math.random() < 0.1,
      a: rand(0.7, 1), w: rand(0.5, 1.8), ph: rand(0, 6.28), t0: now
    };
    if (Math.random() < 0.12) sparks.push({ x: p.tx, y: p.ty, t0: now });
  }

  function prefill(n) {
    var total = Math.min(pool.length, Math.max(0, n | 0) * GRAINS_PER_PERSON);
    for (var i = 0; i < total; i++) {
      var ti = poolCursor; poolCursor = (poolCursor + 1) % pool.length;
      settle({ ti: ti, tx: pool[ti].x, ty: pool[ti].y }, -1e9);
    }
    sparks.length = 0;
  }

  /* ---------- 绘制 ---------- */
  function drawSettled(now) {
    var t = now / 1000;
    for (var i = 0; i < settled.length; i++) {
      var g = settled[i];
      if (!g) continue;
      var a = g.a * (0.78 + 0.22 * Math.sin(t * g.w + g.ph)) * clamp01((now - g.t0) / 500);
      if (g.star) {
        ctx.globalAlpha = a * (0.5 + 0.5 * Math.sin(t * g.w * 1.6 + g.ph));
        ctx.drawImage(goldSprite, g.x - 4.5, g.y - 4.5, 9, 9);
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = g.color;
      ctx.fillRect(g.x - g.size / 2, g.y - g.size / 2, g.size, g.size);
    }
    ctx.globalAlpha = 1;
  }

  function envelope(p) { var a = Math.sin(Math.PI * p); return a * a * 0.85; }

  function drawGlow(now) {
    var level = 0, sweeps = [];
    for (var i = pulses.length - 1; i >= 0; i--) {
      var p = (now - pulses[i]) / FLASH_MS;
      if (p >= 1) { pulses.splice(i, 1); continue; }
      var e = envelope(p);
      level = Math.max(level, e);
      sweeps.push({ p: p, a: e });
    }
    if (level <= 0.003) return;

    ctx.save();
    ctx.shadowColor = 'rgba(255,184,60,' + (0.9 * level) + ')';
    ctx.shadowBlur = 30 * k * level;
    var gf = ctx.createLinearGradient(0, bbox.y0, 0, bbox.y1);
    gf.addColorStop(0, 'rgba(250,208,116,' + (0.42 * level) + ')');
    gf.addColorStop(1, 'rgba(226,160,52,' + (0.42 * level) + ')');
    ctx.fillStyle = gf;
    ctx.fill(glyphPath, 'evenodd');
    ctx.shadowBlur = 0;
    // 每人一道缓慢扫过的柔和流光（最多同时两道）
    ctx.clip(glyphPath, 'evenodd');
    var span = bbox.x1 - bbox.x0 + 360;
    for (var j = 0; j < sweeps.length && j < 2; j++) {
      var sw = sweeps[j];
      var sx = bbox.x0 - 180 + span * easeSine(sw.p);
      var band = ctx.createLinearGradient(sx - 140, 0, sx + 140, 0);
      band.addColorStop(0, 'rgba(255,240,200,0)');
      band.addColorStop(0.5, 'rgba(255,248,226,' + (0.7 * sw.a) + ')');
      band.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = band;
      ctx.fillRect(bbox.x0 - 10, bbox.y0 - 10, bbox.x1 - bbox.x0 + 20, bbox.y1 - bbox.y0 + 20);
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(214,146,36,' + level + ')';
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(255,200,100,0.9)';
    ctx.shadowBlur = 12 * k * level;
    ctx.stroke(glyphPath);
    ctx.restore();
  }

  function drawName(s, now) {
    var t = now - s.born;
    var e = easeOutCubic(clamp01(t / T_APPEAR));
    // 随沙粒散出逐渐变淡
    var left = 1 - s.spawned / s.parts.length;
    var alpha = e * Math.pow(left, 0.7);
    if (alpha <= 0.01) return;
    var dy = (1 - e) * 12 + Math.sin(t / 900) * 1.5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.55;
    ctx.drawImage(s.n.glow, s.x0, s.y0 + dy, s.n.w, s.n.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.drawImage(s.n.ink, s.x0, s.y0 + dy, s.n.w, s.n.h);
    ctx.restore();
  }

  function drawParticles(s, now) {
    if (now < s.dissolve) return;
    var parts = s.parts;
    while (s.spawned < parts.length && parts[s.spawned].t0 <= now) s.spawned++;
    for (var i = 0; i < s.spawned; i++) {
      var p = parts[i];
      if (p.done) continue;
      var u = clamp01((now - p.t0) / p.dur);
      if (u >= 1) {
        p.done = true; s.landed++;
        settle(p, now);
        continue;
      }
      var e = easeSine(u);
      var m = 1 - e;
      var x = m * m * p.sx + 2 * m * e * p.cx + e * e * p.tx;
      var y = m * m * p.sy + 2 * m * e * p.cy + e * e * p.ty;
      x += Math.sin(u * Math.PI * 2 * p.swf + p.ph) * p.sway * (1 - u); // 轻微左右飘摆
      var a = clamp01(u / 0.12) * (0.75 + 0.25 * Math.sin(now / 160 + p.ph));
      var onBook = y > 300;

      ctx.globalAlpha = a * 0.3;
      ctx.globalCompositeOperation = onBook ? 'source-over' : 'lighter';
      ctx.strokeStyle = onBook ? '#E2A640' : p.color;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(x, y); ctx.stroke();

      ctx.globalAlpha = a * (onBook ? 0.5 : 0.85);
      ctx.drawImage(onBook ? goldSprite : sprite, x - 3, y - 3, 6, 6);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a;
      ctx.fillStyle = onBook ? '#D9992E' : p.color;
      ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      p.px = x; p.py = y;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawSparks(now) {
    for (var i = sparks.length - 1; i >= 0; i--) {
      var sp = sparks[i];
      var u = (now - sp.t0) / 700;
      if (u >= 1) { sparks.splice(i, 1); continue; }
      var sz = 5 + 10 * u;
      ctx.globalAlpha = Math.sin(Math.PI * u) * 0.75;
      ctx.drawImage(goldSprite, sp.x - sz / 2, sp.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // 手写字体（约 3MB）只在用到时才会下载，这里主动加载；超时 5 秒则用系统楷体兜底
  var handReady = false;
  var ready = new Promise(function (resolve) {
    function done() { handReady = true; resolve(); }
    if (!document.fonts || !document.fonts.load) return done();
    document.fonts.load(NAME_SIZE + 'px "SignHand"', '张老师').then(done, done);
    setTimeout(done, 5000);
  });

  function step(now) {
    // 有空位且距上一位出场已过间隔才开始下一位；手写字体就绪后再画
    if (queue.length && handReady && now >= nextStartAt) {
      var slot = freeSlot(now);
      if (slot >= 0) {
        start(queue.shift(), slot, now);
        nextStartAt = now + rand(START_GAP[0], START_GAP[1]);
      }
    }

    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);

    drawSettled(now);
    drawGlow(now);
    for (var i = active.length - 1; i >= 0; i--) {
      var s = active[i];
      drawName(s, now);
      drawParticles(s, now);
      if (!s.freed && s.spawned >= s.parts.length) {
        s.freed = true; slotBusy[s.slot] = false; slotFreeAt[s.slot] = now + SLOT_COOLDOWN;
      }
      if (!s.flashed && s.landed >= s.parts.length * 0.8) { s.flashed = true; pulses.push(now); }
      if (s.flashed && s.landed >= s.parts.length) active.splice(i, 1);
    }
    drawSparks(now);
  }

  var running = true;
  var clock = 0, lastRaf = 0;
  function loop(raf) {
    if (!running) return;
    // 用自有时钟：标签页切走/系统休眠回来时最多推进 50ms，动画接着播而不是瞬间跳完
    var dt = lastRaf ? Math.min(50, raf - lastRaf) : 16;
    lastRaf = raf; clock += dt;
    var now = clock;
    step(now);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 调试用：停掉实时循环，按 16ms 步进推演到第 ms 毫秒（无头截图时钟不可靠时用）
  function simulate(ms) {
    running = false;
    for (var t = 0; t <= ms; t += 16) step(t);
  }

  /* ---------- 彩排模拟 ---------- */
  var MOCK_NAMES = ['张老师', '李校长', '王主任', '陈教授', '刘局长', '赵老师', '孙博士', '周主任', '吴老师', '郑校长', '许老师', '盛老师'];
  function mock(n) {
    var names = shuffle(MOCK_NAMES.slice());
    for (var i = 0; i < (n || 1); i++) arrive({ name: names[i % names.length] });
  }

  window.SignFx = { arrive: arrive, prefill: prefill, mock: mock, simulate: simulate, ready: ready };
})();
