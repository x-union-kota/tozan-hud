/* ============================================================
 * app.js — 登山HUD アプリ層
 *   モード: disclaimer → (resume) → select → ready → main ⇄ warn → done
 *   ナビゲーション: 公式仕様に合わせ pushState/popstate で管理
 *   (バックジェスチャー=シェルが history.back() を呼ぶ。エントリ上限5)
 * ============================================================ */
(function () {
  'use strict';

  var SIM = /[?&]sim=1/.test(location.search);

  // センサー診断(実機で方位が取れない問題の切り分け用。ready画面で↓表示)
  var DIAG = { oriFn: '?', motFn: '?', oriPerm: '-', motPerm: '-', reqMs: 0, retryN: 0,
               absN: 0, oriN: 0, motN: 0, alpha: null, wkc: null, absFlag: null,
               raw: null, rawErr: '', fixW: 0, fixP: 0, beta: null, gamma: null };

  /* ---------------- 状態(単一オブジェクト) ---------------- */
  var S = {
    mode: 'disclaimer',
    routeIdx: 0, route: null,
    panel: 0,                 // 0進捗 1次WP 2天気
    theme: 'y',               // y=黄(高輝度) w=白
    perm: '', starting: false, startFailed: false, sensorsReady: false, diag: false,
    startCands: null, startIdx: 0, startManual: false, startSuggested: false, readyGeo: null,
    identLayer: 'ground', identFilter: 0, identSel: 0, night: false,
    lap: 1, lapTimes: [], lapStartMs: 0, lapHist: [], segState: null, segPB: {},
    ghost: null, ghostSrc: '', prevGhostGap: null, overtakeArmed: true,
    paceGoal: null, paceEdit: null,   // N8: 目標タイム(分)。paceEdit非nullの間はready上の目標ペース層
    ceremonyDone: {}, summitLog: [],
    home: lsGet('thud.home'),
    tracking: false,
    startMs: 0, movingMin: 0, stopMin: 0,
    lastFix: null, lastFixReal: 0, lastGoodFixReal: 0,
    cursor: null, along: 0, maxAlong: 0, proj: null,
    emaKmh: 0, moving: true, lastMoveMs: 0,
    dev: null, suppressUntil: 0, graceUntil: 0,
    heading: null, headingReal: 0, headingSettled: false, hmode: (lsGet('thud.hmode') || 'alpha'),
    sun: null, sunNotice: false,
    wx: null, wxTriedMs: 0,
    track: [], lastTrackMs: 0,
    wpPassed: {}, wpFlashUntil: 0, wpFlashMsg: '',
    permDenied: false,
    finished: null,
    resumeData: null
  };
  var BUILT = ROUTES.map(CORE.buildRoute);

  /* ---------------- 時刻(simは加速クロック) ---------------- */
  var simClockOff = 0;
  (function () {   // ?t=HH:MM で時計を上書き(星空・日没の机上検証)
    var m = /[?&]t=(\d{1,2}):(\d{2})/.exec(location.search);
    if (m) {
      var d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
      simClockOff = d.getTime() - Date.now();
    }
  })();
  function nowMs() { return Date.now() + simClockOff; }
  function nowDate() { return new Date(nowMs()); }

  /* ---------------- localStorage(常にtry-catch) ---------------- */
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* ================= Geo抽象化(実機 / sim) ================= */
  var Geo = (function () {
    var watchId = null;
    var sim = {
      running: false, timer: null,
      along: 0, mul: 20, offset: 0, paused: false,
      lostUntil: 0, degraded: false, teleport: false,
      mps: 1.0
    };
    function gauss() { var s = 0; for (var i = 0; i < 6; i++) s += Math.random(); return (s - 3) / 3; }

    function simTick(cb) {
      var realNow = Date.now();
      if (sim.lostUntil > realNow) return;             // GPS喪失注入
      var dt = 1 * sim.mul;                             // sim秒
      simClockOff += (dt - 1) * 1000;                   // simクロック加速
      if (!sim.paused) {
        sim.along += sim.mps * dt;
        if (CORE.isLoop(S.route)) { if (sim.along >= S.route.total) sim.along -= S.route.total; }
        else sim.along = Math.min(S.route.total, sim.along);
      }
      var p = CORE.routePointAt(S.route, sim.along);
      var pos = [p.la, p.lo];
      if (sim.offset) {                                 // 逸脱注入(進行方向と直交)
        var ahead = CORE.routePointAt(S.route, Math.min(S.route.total, sim.along + 30));
        var brg = CORE.bearing(pos, [ahead.la, ahead.lo]);
        pos = CORE.destPoint(pos[0], pos[1], (brg + 90) % 360, sim.offset);
      }
      var sigma = sim.degraded ? 35 : 6;
      var acc = sim.degraded ? 90 + Math.random() * 40 : 8 + Math.random() * 14;
      if (sim.teleport) { sim.teleport = false; pos = CORE.destPoint(pos[0], pos[1], Math.random() * 360, 400); acc = 15; }
      pos = CORE.destPoint(pos[0], pos[1], Math.random() * 360, Math.abs(gauss()) * sigma);
      // 方位: 進行方向+ゆらぎ
      var ah2 = CORE.routePointAt(S.route, Math.min(S.route.total, sim.along + 40));
      S.heading = (CORE.bearing([p.la, p.lo], [ah2.la, ah2.lo]) + (sim.headOff || 0) + gauss() * 8 + 360) % 360;
      S.headingReal = Date.now(); S.headingSettled = true;
      cb({ la: pos[0], lo: pos[1], acc: acc, t: nowMs() });
    }

    return {
      sim: sim,
      start: function (cb, errCb) {
        if (SIM) {
          sim.running = true;
          sim.mps = S.route.total / (S.route.ctTotal * 60) * 1.05; // CTよりやや速く
          sim.timer = setInterval(function () { simTick(cb); }, 1000);
          return;
        }
        if (!navigator.geolocation) { errCb({ code: 2, message: 'no geolocation' }); return; }
        watchId = navigator.geolocation.watchPosition(
          function (pos) {
            DIAG.fixW++;
            cb({ la: pos.coords.latitude, lo: pos.coords.longitude,
                 acc: pos.coords.accuracy, t: pos.timestamp || Date.now() });
          },
          errCb,
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
        );
      },
      once: function (cb) {                              // 再点灯時の即時判定用
        if (SIM) return;
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(function (pos) {
          cb({ la: pos.coords.latitude, lo: pos.coords.longitude,
               acc: pos.coords.accuracy, t: pos.timestamp || Date.now() });
        }, function () {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
      },
      stop: function () {
        if (sim.timer) { clearInterval(sim.timer); sim.timer = null; sim.running = false; }
        if (watchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      }
    };
  })();

  /* ================= 権限(公式: ユーザージェスチャー起点 / pushState前に解決) ================= */
  // 重要(公式仕様): センサー権限はユーザージェスチャーから同期的に呼ぶ。
  // かつ、この Promise が解決するまで history.pushState を一切行わないこと。
  // 先に履歴を変更すると requestPermission が永久に pending になりアプリがハングする。
  function reqPerm(cls, tag) {
    return new Promise(function (res) {
      try {
        var C = window[cls];
        DIAG[tag + 'Fn'] = (typeof C === 'undefined') ? 'クラス無'
          : (typeof C.requestPermission === 'function' ? 'あり' : '関数無(自動付与)');
        if (C && typeof C.requestPermission === 'function') {
          C.requestPermission().then(
            function (r) { DIAG[tag + 'Perm'] = String(r); res(); },
            function () { DIAG[tag + 'Perm'] = 'reject'; res(); });
        } else { DIAG[tag + 'Perm'] = '(不要)'; res(); }
      } catch (e) { DIAG[tag + 'Perm'] = 'err'; res(); }
    });
  }
  function ensureSensors() {
    if (SIM) return Promise.resolve();
    try {  // Motionは存在チェックのみ(2連プロンプトの競合を避ける)
      var M = window.DeviceMotionEvent;
      DIAG.motFn = (typeof M === 'undefined') ? 'クラス無'
        : (typeof M.requestPermission === 'function' ? 'あり' : '関数無(自動付与)');
      DIAG.motPerm = '(未要求)';
    } catch (e) {}
    DIAG.reqMs = Date.now();
    return reqPerm('DeviceOrientationEvent', 'ori');
  }
  function ensureGeo() {
    return new Promise(function (res, rej) {
      if (SIM) { res(null); return; }
      if (!navigator.geolocation) { rej({ code: 2 }); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) { res({ la: pos.coords.latitude, lo: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() }); },
        function (err) { rej(err); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }
  var oriAttached = false, lastAbsMs = 0;
  var hsx = 0, hsy = 0, hInit = false, firstOriMs = 0, unstableUntil = 0;
  function oriHandler(isAbs) {
    return function (e) {
      if (isAbs) DIAG.absN++; else DIAG.oriN++;
      DIAG.alpha = e.alpha; DIAG.wkc = e.webkitCompassHeading; DIAG.absFlag = e.absolute;
      if (e.beta != null) DIAG.beta = e.beta;      // 仰角スパイク用(N7bの前提データ)
      if (e.gamma != null) DIAG.gamma = e.gamma;
      var h = null;
      if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;   // iOS系
      else if (e.alpha != null) {
        // MRBD公式Doc: heading = e.alpha (alpha直)。標準Androidは 360-α なので切替可能に
        var al = ((e.alpha % 360) + 360) % 360;
        h = (S.hmode === 'inv') ? (360 - al) % 360 : al;
      }
      if (h == null) return;
      var t = Date.now();
      if (isAbs) lastAbsMs = t;
      else if (t - lastAbsMs < 3000) return;               // absoluteが生きていればそちらを優先
      // 起動直後はセンサー融合が収束しておらず数秒間デタラメな値が出る。
      // 円形EMAで平滑し、生値と平滑値の乖離が続く間は「較正中」として矢印を出さない
      if (!firstOriMs) firstOriMs = t;
      var rad = h * Math.PI / 180, k = 0.35;
      if (!hInit) { hsx = Math.sin(rad); hsy = Math.cos(rad); hInit = true; }
      else { hsx = k * Math.sin(rad) + (1 - k) * hsx; hsy = k * Math.cos(rad) + (1 - k) * hsy; }
      var sm = (Math.atan2(hsx, hsy) * 180 / Math.PI + 360) % 360;
      var diff = Math.abs(((h - sm + 540) % 360) - 180);
      if (diff > 25) unstableUntil = t + 1200;
      S.headingSettled = (t - firstOriMs > 2000) && (t > unstableUntil);
      S.heading = sm; S.headingReal = t; scheduleArrow();
    };
  }
  function startOrientation() {
    if (SIM || oriAttached) return;
    oriAttached = true;
    // 環境によって発火するイベントが異なるため両方購読する
    window.addEventListener('deviceorientationabsolute', oriHandler(true));
    window.addEventListener('deviceorientation', oriHandler(false));
    window.addEventListener('devicemotion', function () { DIAG.motN++; });
  }

  var readyGeoLast = 0;
  function readyGeoPoll() {   // スタートWPサジェスト用の単発測位(toReadyのジェスチャー文脈から同期発行)
    if (SIM) { return; }
    if (!navigator.geolocation || Date.now() - readyGeoLast < 10000) return;
    readyGeoLast = Date.now();
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        S.readyGeo = { la: p.coords.latitude, lo: p.coords.longitude, acc: p.coords.accuracy };
        suggestStart(); render();
      }, function () {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 20000 });
    } catch (e) {}
  }
  function suggestStart() {
    if (!S.startCands || !S.readyGeo || S.startManual) return;
    var best = -1, bd = 1e18;
    for (var i = 0; i < S.startCands.length; i++) {
      var p = CORE.routePointAt(S.route, S.startCands[i].d);
      var d = CORE.hav([S.readyGeo.la, S.readyGeo.lo], [p.la, p.lo]);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd < 500 && best !== S.startIdx) {   // 現在地500m以内の最寄りWPを自動選択
      S.startIdx = best; S.startSuggested = true;
    } else if (best === S.startIdx && bd < 500) {
      S.startSuggested = true;
    }
  }
  function candDist(i) {
    if (!S.readyGeo || !S.startCands) return null;
    var p = CORE.routePointAt(S.route, S.startCands[i].d);
    return CORE.hav([S.readyGeo.la, S.readyGeo.lo], [p.la, p.lo]);
  }

  var diagGeoLast = 0;
  function diagPollGeo() {
    // システムチェック: 生の測位値を直接表示するための単発測位(5秒ごと)
    if (SIM) { if (S.lastFix) DIAG.raw = { la: S.lastFix.la, lo: S.lastFix.lo, acc: S.lastFix.acc, t: Date.now() }; return; }
    if (!navigator.geolocation || Date.now() - diagGeoLast < 5000) return;
    diagGeoLast = Date.now();
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        DIAG.raw = { la: p.coords.latitude, lo: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
        DIAG.rawErr = ''; render();
      }, function (e) { DIAG.rawErr = '測位エラー code=' + e.code; render(); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    } catch (e) {}
  }

  function headingTrue() {   // 磁方位→真方位(西偏を減算)。ラベル照合は必ずこちらを使う
    if (S.heading == null) return null;
    var dec = (S.route && S.route.dec) || 7.5;
    return ((S.heading - dec) % 360 + 360) % 360;
  }

  /* ================= 履歴ナビゲーション ================= */
  var backFlag = '';   // 'suppress' | 'auto' | ''
  function goBack(flag) { backFlag = flag || ''; try { history.back(); } catch (e) {} }

  function initHistory() { try { history.replaceState({ s: 'select' }, ''); } catch (e) {} }
  // sensorsReady が立つまで履歴を変更しない(公式のハング条件の回避)
  function pushScreen(s) {
    if (!S.sensorsReady) return;
    try { history.pushState({ s: s }, ''); } catch (e) {}
  }
  function replaceScreen(s) {
    if (!S.sensorsReady) return;
    try { history.replaceState({ s: s }, ''); } catch (e) {}
  }

  window.addEventListener('popstate', function (e) {
    var target = (e.state && e.state.s) || 'select';
    var from = S.mode;
    if ((from === 'ident' || from === 'cere') && target === 'main') {
      setNight(false); S.mode = 'main'; render(); return;
    }
    if (from === 'warn' && (target === 'ident')) { S.mode = 'ident'; render(); return; }
    if (from === 'warn' && target === 'main') {
      // 手動クローズ(戻る)で逸脱継続中 → 60秒は再警告しない
      if (backFlag === '' && S.dev && S.dev.state.deviated) S.graceUntil = nowMs() + 60000;
      backFlag = '';
      S.mode = 'main'; render(); return;
    }
    if (target === 'ready' && S.tracking) {              // main から戻る = 山行終了
      finishHike();
      try { history.replaceState({ s: 'done' }, ''); } catch (e2) {}
      S.mode = 'done'; render(); return;
    }
    if (target === 'ready') { S.mode = 'ready'; render(); return; }
    // select(root) へ
    if (from === 'resume') { lsDel('thud.active'); S.resumeData = null; }   // 戻る=破棄
    resetToSelect(); render();
  });

  /* ================= トラッキング ================= */
  var startWatchdog = null;
  function clearStartWatchdog() { if (startWatchdog) { clearTimeout(startWatchdog); startWatchdog = null; } }

  function beginStart(restore) {
    if (S.starting) return;
    S.starting = true; S.startFailed = false;
    S.perm = '位置情報とセンサーの許可を確認中…'; render();

    // 権限プロンプトが未応答のままだと getCurrentPosition の timeout が
    // 走らないブラウザがある(ここで永久に止まるのを防ぐ番人)
    clearStartWatchdog();
    startWatchdog = setTimeout(function () {
      if (!S.starting) return;
      S.starting = false; S.startFailed = true;
      S.perm = '位置情報の応答がありません。許可ダイアログを確認してください。' +
               'ピンチでGPSなしのまま開始(取得でき次第あとから表示されます)';
      render();
    }, 20000);

    // 位置情報もユーザージェスチャー起点である必要がある。
    // ensureSensors() の解決を待ってから呼ぶとジェスチャー文脈を外れるため、
    // ここで同期的に発行する(センサー権限は免責画面で取得済み)。
    ensureGeo().then(function (fix) {
      clearStartWatchdog();
      S.perm = ''; S.starting = false;
      startTracking(fix, restore);                       // 再開時の履歴はdoResumeで置換済み
    }, function (err) {
      clearStartWatchdog();
      S.starting = false;
      if (err && err.code === 1) {
        S.permDenied = true; S.startFailed = false;
        S.perm = '位置情報が許可されませんでした。ブラウザ/グラスの設定で許可してから、もう一度ピンチ';
      } else {
        // 取得不能・タイムアウト: 山行そのものは止めない。watchPosition が
        // あとから成功する可能性があるので、⑤帯に警告を出したまま開始できる
        S.startFailed = true;
        S.perm = '現在地を取得できませんでした(code=' + ((err && err.code) || '?') + ')。' +
                 'ピンチでGPSなしのまま開始';
      }
      render();
    });
  }
  function startAnyway(restore) {
    clearStartWatchdog();
    S.starting = false; S.startFailed = false; S.perm = '';
    startTracking(null, restore);
  }

  function startTracking(firstFix, restore) {
    pushScreen('main');                                   // ←権限解決後にpushState(公式の既知問題対策)
    S.mode = 'main'; S.tracking = true;
    if (!restore && S.startCands && S.startIdx > 0) {     // 選択WPを原点に周回を回転
      var sw = S.startCands[S.startIdx];
      S.route = CORE.rotateLoop(S.route, sw.d, sw.n);
      S.rotOff = sw.d;
    } else if (!restore) { S.rotOff = 0; }
    if (!restore) {
      S.startMs = nowMs(); S.movingMin = 0; S.stopMin = 0;
      S.track = []; S.wpPassed = {}; S.along = 0; S.maxAlong = 0;
      S.cursor = null; S.emaKmh = 0; S.midJoinChecked = false;
    }
    S.dev = CORE.createDevFSM({ trig: 50, clear: 35, need: 3, accMax: 75 });
    if (!restore) {
      S.lap = 1; S.lapTimes = []; S.lapStartMs = nowMs(); S.lapHist = []; S.segState = null;
      S.ceremonyDone = {}; S.summitLog = []; S.prevGhostGap = null; S.overtakeArmed = true;
      var lastTk = lsGet('thud.lastTrack.' + S.route.id);
      if (lastTk && lastTk.length > 8) { S.ghost = { samples: lastTk }; S.ghostSrc = 'last'; }
      else { S.ghost = null; S.ghostSrc = 'ct'; }
    }
    // 目標ペースは明示設定なので他ソースより優先。時計だけで決まるので復元時もそのまま効く
    if (S.paceGoal > 0) { S.ghost = null; S.ghostSrc = 'pace'; }
    S.lastMoveMs = nowMs(); S.moving = true;
    S.sun = CORE.sunTimes(S.route.pts[0][0], S.route.pts[0][1], nowDate());
    Geo.start(onFix, onGeoErr);
    if (firstFix) onFix(firstFix);
    startTicker();
    render();
  }

  function onGeoErr(err) {
    if (err && err.code === 1) { S.permDenied = true; }
    // それ以外は鮮度監視(⑤帯)に任せる — 沈黙しない方針
  }

  function onFix(f) {
    var prev = S.lastFix;
    S.lastFix = f; S.lastFixReal = Date.now();
    if (f.acc != null && f.acc > 75) { return; }         // 低精度は生存確認のみ(F2/判定不使用)
    var m = CORE.matchLocal(S.route, S.cursor, f.la, f.lo, S.along); // 初回もalong=0起点でバイアス(ピストンの往復同一線形対策)
    if (!m) return;
    S.lastGoodFixReal = Date.now();
    S.cursor = m.seg; S.proj = m;
    S.along = m.along;
    if (!S.midJoinChecked) {                             // 初回射影がルート中腹なら明示する
      S.midJoinChecked = true;
      if (m.along > 300 && m.dist < 200) wpFlash('途中から合流 (' + CORE.fmtKm(m.along) + '地点)');
    }
    if (m.along > S.maxAlong) S.maxAlong = m.along;
    // 速度・移動判定
    if (prev && prev.acc <= 75) {
      var dt = (f.t - prev.t) / 1000;
      if (dt >= 1 && dt <= 180) {
        var v = CORE.hav([prev.la, prev.lo], [f.la, f.lo]) / dt;   // m/s
        if (v > 0.3) S.lastMoveMs = nowMs();
        if (v > 0.2 && v < 3.5) {
          var kmh = v * 3.6;
          S.emaKmh = S.emaKmh ? (0.85 * S.emaKmh + 0.15 * kmh) : kmh;
        }
      }
    }
    S.dev.step(m.dist, f.acc);
    checkWpAuto(f);
    evalWarn();
  }

  function checkWpAuto(f) {                              // W3: 半径30mで自動通過
    for (var i = 0; i < S.route.wps.length; i++) {
      var w = S.route.wps[i];
      if (S.wpPassed[w.d]) continue;
      var p = CORE.routePointAt(S.route, w.d);
      if (CORE.hav([f.la, f.lo], [p.la, p.lo]) < 30) {
        S.wpPassed[w.d] = true;
        if (w.t === 'peak' && !S.ceremonyDone[w.n]) { startCeremony(w); }
        else wpFlash(w.n + ' 通過');
      }
    }
  }
  function startCeremony(w) {                             // N5: 登頂儀式(1山行1山頂1回)
    S.ceremonyDone[w.n] = true;
    var col = lsGet('thud.peaks') || {};
    var isNew = !col[w.n];
    col[w.n] = Date.now(); lsSet('thud.peaks', col);
    var total = Object.keys(col).length;
    S.summitLog.push(w.n);
    var p = CORE.routePointAt(S.route, w.d);
    var el = S.route.pts[p.seg] ? Math.round(S.route.pts[p.seg][2]) : null;
    S.cereData = { n: w.n, el: el, total: total, isNew: isNew };
    if (S.mode === 'main') { pushScreen('cere'); S.mode = 'cere'; render(); }
    else wpFlash(w.n + ' 登頂! 通算' + total + '座');
  }
  function scrCeremony() {
    var c = S.cereData || {};
    return '<div class="abs ctr" style="top:120px"><div class="sub acc2">登頂</div>' +
      '<div class="big1 main-c" style="font-size:64px;margin-top:10px">' + esc(c.n || '') + '</div>' +
      (c.el != null ? '<div class="big2 main-c">' + c.el + 'm</div>' : '') + '</div>' +
      '<div class="abs ctr" style="top:360px"><span class="eta1">通算 ' + (c.total || 1) + ' 座目' +
      (c.isNew ? '' : ' <span class="dim sub">(再登頂)</span>') + '</span></div>' +
      '<div class="abs ctr" style="bottom:40px"><span class="hint dim">ピンチ: 山座同定へ ／ 戻る</span></div>';
  }
  function wpFlash(msg) { S.wpFlashMsg = msg; S.wpFlashUntil = nowMs() + 8000; }

  function isLoopRoute() { return CORE.isLoop(S.route); }
  function checkLapAndSegs(t) {
    if (!S.tracking || !S.proj) return;
    // 進行方向ゲート: 直近45秒のalong履歴で「前進して通過した」ときだけラップを発火させる。
    // 起点付近での後戻り・うろうろ(alongが横ばい/減少)では発火しない(v3レビュー指摘)。
    if (!S.lapHist) S.lapHist = [];
    S.lapHist.push([t, S.along]);
    while (S.lapHist.length > 2 && t - S.lapHist[0][0] > 45000) S.lapHist.shift();
    var lapFwd = S.lapHist.length >= 2 &&
                 (t - S.lapHist[0][0]) >= 5000 &&
                 (S.along - S.lapHist[0][1]) >= 15;
    if (isLoopRoute() && lapFwd && S.along > S.route.total - 30 && S.lastFix &&
        CORE.hav([S.lastFix.la, S.lastFix.lo], [S.route.pts[0][0], S.route.pts[0][1]]) < 30) {
      var lapSec = (t - S.lapStartMs) / 1000;
      if (lapSec > 120) {                                  // 誤発火防止
        S.lapTimes.push(Math.round(lapSec));
        if (S.lap === 1 && S.track.length > 4 && S.ghostSrc !== 'pace') {   // 明示設定の目標ペースは奪わない
          S.ghost = { samples: S.track.map(function (s) { return [s[0], s[3] || 0]; }) };
          S.ghostSrc = 'lap1';
          wpFlash('Lap ' + S.lap + ' ' + CORE.fmtDur(lapSec / 60) + ' — 1周目の自分が背中に');
        } else {
          wpFlash('Lap ' + S.lap + ' ' + CORE.fmtDur(lapSec / 60));
        }
        S.lap++; S.lapStartMs = t; S.lapHist = [];
        S.along = 0; S.cursor = 0; S.maxAlong = 0;          // マッチャー巻き戻し(v3レビュー指摘)
        S.wpPassed = {}; S.segState = null; S.prevGhostGap = null;
      }
    }
    var segs = S.route.segs || [];
    for (var i = 0; i < segs.length && i < 3; i++) {
      var sg = segs[i];
      if (!S.segState && S.along >= sg.a && S.along < sg.b) {
        var pb = (lsGet('thud.seg.' + S.route.id) || {})[sg.n];
        S.segState = { n: sg.n, b: sg.b, t0: t };
        wpFlash('⚔ ' + sg.n + (pb ? ' PB ' + CORE.fmtDur(pb / 60) : ''));
      } else if (S.segState && S.segState.n === sg.n && S.along >= sg.b) {
        var sec = Math.round((t - S.segState.t0) / 1000);
        var key = 'thud.seg.' + S.route.id;
        var all = lsGet(key) || {};
        var old = all[sg.n];
        if (!old || sec < old) { all[sg.n] = sec; lsSet(key, all); wpFlash(sg.n + ' ' + CORE.fmtDur(sec / 60) + ' 自己ベスト!'); }
        else wpFlash(sg.n + ' ' + CORE.fmtDiff((sec - old) / 60) + ' (PB比)');
        S.segState = null;
      }
    }
    var gA = ghostAlongNow();
    if (gA != null && S.proj) {
      var gap = S.along - gA;
      if (S.prevGhostGap != null) {
        if (S.overtakeArmed && S.prevGhostGap < -20 && gap > 0) {
          wpFlash('ゴーストを抜いた!'); S.overtakeArmed = false;
        }
        if (!S.overtakeArmed && gap < -20) S.overtakeArmed = true;
      }
      S.prevGhostGap = gap;
    }
  }

  // 背中オーバーレイ(覗き窓表現: 点+距離+接近率。人型は単眼20px級で潰れるため不採用)
  var ghostDistHist = [];
  function ghostOverlayHtml() {
    if (S.mode !== 'main' || !S.tracking || !S.proj) return '';
    var st = staleInfo();
    if (st.sec > 90 || offRouteNow() || !S.headingSettled) return '';   // 正直さゲート
    var gA = ghostAlongNow();
    if (gA == null) return '';
    var ht = headingTrue(); if (ht == null) return '';
    var gp = CORE.routePointAt(S.route, gA);
    var me = [S.lastFix.la, S.lastFix.lo];
    var dist = CORE.hav(me, [gp.la, gp.lo]);
    if (gA <= S.along) {
      S.ghostBehind = (S.along - gA < 500) ? Math.round(dist) : null;
      return '';
    }
    S.ghostBehind = null;
    var rel = CORE.angDiff(CORE.bearing(me, [gp.la, gp.lo]), ht);
    if (Math.abs(rel) > 25 || dist > 150) return '';
    var x = 300 + rel * (270 / 25);
    var rr = Math.max(4, Math.min(22, 22 - dist / 8));
    var t = Date.now();
    ghostDistHist.push([t, dist]);
    while (ghostDistHist.length && t - ghostDistHist[0][0] > 10000) ghostDistHist.shift();
    var trend = '';
    if (ghostDistHist.length > 3) {
      var dd = dist - ghostDistHist[0][1];
      trend = dd < -3 ? '▼' : (dd > 3 ? '▲' : '');
    }
    return '<div class="abs" style="top:64px;left:0;right:0;height:70px;pointer-events:none">' +
      '<svg viewBox="0 0 600 70" width="600" height="70">' +
      '<circle cx="' + x.toFixed(0) + '" cy="30" r="' + rr.toFixed(0) + '" fill="none" stroke="#6b675c" stroke-width="3"/>' +
      '<text x="' + x.toFixed(0) + '" y="64" fill="#6b675c" font-size="16" text-anchor="middle" font-family="inherit">' +
      Math.round(dist) + 'm' + trend + '</text></svg></div>';
  }
  function manualWp() {                                  // 次WPパネルのEnter: 手動補正
    var w = nextWp();
    if (!w) return;
    var distTo = Math.max(0, w.d - S.along);
    if (distTo > 500) {                                  // 誤ピンチでWPを消費しない
      wpFlash(w.n + 'まで' + CORE.fmtKm(distTo) + ' (確認は500m以内)'); render(); return;
    }
    S.wpPassed[w.d] = true; wpFlash(w.n + ' 通過(手動)'); render();
  }
  function nextWp() {
    for (var i = 0; i < S.route.wps.length; i++) {
      var w = S.route.wps[i];
      if (!S.wpPassed[w.d] && w.d > 40) return w;
    }
    return null;
  }

  function evalWarn() {
    if (!S.tracking || !S.dev) return;
    var d = S.dev.state.deviated;
    var t = nowMs();
    if (d && (S.mode === 'main' || S.mode === 'ident' || S.mode === 'cere') && t >= S.suppressUntil && t >= S.graceUntil) {
      if (S.mode !== 'main') setNight(false);
      pushScreen('warn'); S.mode = 'warn'; render();
    } else if (!d && S.mode === 'warn') {
      goBack('auto');                                    // 復帰で自動解除
    }
  }

  function finishHike() {
    Geo.stop(); stopTicker();
    S.tracking = false;
    var elapsed = (nowMs() - S.startMs) / 60000;
    var ctDone = CORE.ctAt(S.route, S.maxAlong);
    S.finished = {
      dist: S.maxAlong, elapsed: elapsed,
      moving: S.movingMin, stop: S.stopMin,
      ctRatio: (ctDone && ctDone > 10) ? (S.movingMin / ctDone) : null
    };
    S.finished.laps = S.lapTimes.slice();
    S.finished.summits = S.summitLog.slice();
    S.finished.peakTotal = Object.keys(lsGet('thud.peaks') || {}).length;
    if (S.ghostSrc === 'pace' && S.paceGoal > 0 && !isLoopRoute()) {
      S.finished.ghostDiff = elapsed - S.paceGoal;          // 目標ペースは経過時計そのものが基準
      S.finished.ghostLbl = '目標ペース';
    } else {
      var gd = CORE.ctAt(S.route, S.maxAlong);
      S.finished.ghostDiff = (gd && gd > 10) ? (S.movingMin - gd) : null;
    }
    if (S.track.length > 8) {
      lsSet('thud.lastTrack.' + S.route.id, S.track.map(function (s) { return [s[0], s[3] || 0]; }));
    }
    lsDel('thud.active');
    lsSet('thud.lastResult', { routeId: S.route.id, at: Date.now(), sum: S.finished });
  }

  function resetToSelect() {
    Geo.stop(); stopTicker();
    S.mode = 'select'; S.tracking = false; S.finished = null;
    S.perm = ''; S.starting = false; S.startFailed = false; S.panel = 0;
    if (S.dev) S.dev.reset();
    S.suppressUntil = 0; S.graceUntil = 0;
  }

  /* ================= 定期処理(1Hz) ================= */
  var ticker = null, lastTickMs = 0;
  function startTicker() { if (!ticker) { lastTickMs = nowMs(); ticker = setInterval(tick, 1000); } }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  var geoPolling = false;
  function keepAlivePoll() {
    // watchPositionは「位置が変わらないと報告しない」実装があるため、
    // 無報告20秒で単発測位を打って生存確認する。これが失敗し続けたときだけ本物の喪失
    if (SIM || geoPolling || !navigator.geolocation) return;
    if (Date.now() - S.lastFixReal < 20000) return;
    geoPolling = true;
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        geoPolling = false; DIAG.fixP++;
        onFix({ la: p.coords.latitude, lo: p.coords.longitude,
                acc: p.coords.acc || p.coords.accuracy, t: p.timestamp || Date.now() });
      }, function () { geoPolling = false; },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    } catch (e) { geoPolling = false; }
  }

  function tick() {
    if (S.mode === 'ready' && S.diag) { diagPollGeo(); render(); return; }   // 診断表示のライブ更新+GPS単発測位
    if (S.mode !== 'main' && S.mode !== 'warn') return;  // 非アクティブ時は進行停止(ガイド準拠)
    if (S.tracking) keepAlivePoll();
    var t = nowMs();
    var dtMin = Math.min((t - lastTickMs) / 60000, 5);   // 復帰直後の巨大dtを抑制
    lastTickMs = t;
    S.moving = (t - S.lastMoveMs) < 90000;
    if (S.moving) S.movingMin += dtMin; else S.stopMin += dtMin;
    // トラック記録(F8: 60秒ごと)
    if (S.lastFix && t - S.lastTrackMs >= 15000) {   // v3: 背中ソース用に15秒へ
      S.lastTrackMs = t;
      S.track.push([Math.round((t - S.startMs) / 1000), +S.lastFix.la.toFixed(5), +S.lastFix.lo.toFixed(5), Math.round(S.along)]);
      if (S.track.length > 2400) S.track = S.track.filter(function (_, i) { return i % 2 === 0; });
      saveActive();
    }
    checkLapAndSegs(t);
    // 日没90分前通知(1回)
    if (S.sun && S.sun.sunset && !S.sunNotice) {
      var remMin = (S.sun.sunset.getTime() - t) / 60000;
      if (remMin > 0 && remMin <= 90) { S.sunNotice = true; wpFlash('日没90分前 ヘッデン準備'); }
    }
    evalWarn();
    render();
  }

  function saveActive() {
    lsSet('thud.active', {
      routeId: S.route.id, startMs: S.startMs, savedAt: Date.now(),
      movingMin: S.movingMin, stopMin: S.stopMin,
      along: S.along, maxAlong: S.maxAlong, cursor: S.cursor,
      wpPassed: S.wpPassed, track: S.track.slice(-600), emaKmh: S.emaKmh, rot: S.rotOff || 0
    });
  }

  /* ================= 再点灯・復帰時の即時判定(プル型F4) ================= */
  function wakeCheck() {
    if (!S.tracking) return;
    lastTickMs = nowMs();
    Geo.once(function (f) { onFix(f); render(); });
    render();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') wakeCheck();
  });
  window.addEventListener('pageshow', wakeCheck);

  /* ================= 天気キャッシュ(W2) ================= */
  function fetchWeather() {
    var key = 'thud.wx.' + S.route.id;
    S.wx = lsGet(key);
    if (SIM && !S.wx) {                                  // simはダミー投入
      var rows = [], base = nowDate().getHours();
      for (var i = 0; i < 4; i++) rows.push({ t: Date.now() + i * 3 * 3600000,
        h: (base + i * 3) % 24, temp: 18 - i, pp: [10, 20, 40, 60][i] });
      S.wx = { t: Date.now() - 3 * 3600000, rows: rows };
      return;
    }
    // navigator.onLine はグラス(スマホ経由接続)で偽を返す可能性があるため見ない。常に試行して失敗は黙殺
    if (typeof fetch !== 'function') return;
    if (S.wxTriedMs && Date.now() - S.wxTriedMs < 60000) return;   // 60秒に1回まで
    S.wxTriedMs = Date.now();
    var p = S.route.pts[0];
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p[0].toFixed(4) +
      '&longitude=' + p[1].toFixed(4) +
      '&hourly=temperature_2m,precipitation_probability&forecast_hours=12&timezone=auto';
    try {
      fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.hourly) return;
        var rows = [];
        for (var i = 0; i < j.hourly.time.length && rows.length < 4; i += 3) {
          rows.push({ t: Date.parse(j.hourly.time[i]),   // timezone=auto=端末ローカル(日本)前提
                      h: parseInt(j.hourly.time[i].slice(11, 13), 10),
                      temp: Math.round(j.hourly.temperature_2m[i]),
                      pp: j.hourly.precipitation_probability[i] });
        }
        S.wx = { t: Date.now(), rows: rows };
        lsSet(key, S.wx); render();
      })['catch'](function () {});
    } catch (e) {}
  }

  /* ================= 入力 ================= */
  var KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Backspace'];
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (SIM && handleSimKey(k)) { e.preventDefault(); return; }
    if (KEYS.indexOf(k) < 0) return;
    e.preventDefault();
    if (k === 'Backspace') k = 'Escape';   // 公式サンプルは Backspace も戻る扱い

    if (S.mode === 'disclaimer') {
      if (k === 'Enter' || k === 'Escape') requestSensorsThen(afterDisclaimer);
      return;
    }
    if (S.mode === 'resume') {
      if (k === 'Enter') { doResume(); }
      if (k === 'Escape') goBack();          // 破棄はpopstate側で実施(実機のバックと同経路)
      return;
    }
    if (S.mode === 'select') {
      if (k === 'ArrowLeft')  { S.routeIdx = (S.routeIdx + BUILT.length - 1) % BUILT.length; render(); }
      if (k === 'ArrowRight') { S.routeIdx = (S.routeIdx + 1) % BUILT.length; render(); }
      if (k === 'Enter') { toReady(); }
      return;
    }
    if (S.mode === 'ready') {
      if (S.paceEdit != null) {                             // N8: 目標ペース層(↑で開く)
        var rg = paceRange();
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          var nv = (S.paceEdit === 0)
            ? (k === 'ArrowRight' ? rg[0] : 0)
            : S.paceEdit + (k === 'ArrowRight' ? PACE_STEP : -PACE_STEP);
          if (nv < rg[0]) nv = 0;                           // 下限より下は「設定しない」
          if (nv > rg[1]) nv = rg[1];
          S.paceEdit = nv; render(); return;
        }
        if (k === 'Enter') {
          S.paceGoal = (S.paceEdit > 0) ? S.paceEdit : null;
          if (S.paceGoal) { lsSet(paceKey(), S.paceGoal); wpFlash('目標 ' + CORE.fmtDur(S.paceGoal) + ' のゴーストを出します'); }
          else { lsDel(paceKey()); wpFlash('目標ペースを解除しました'); }
          S.paceEdit = null; render(); return;
        }
        S.paceEdit = null; render(); return;                // ↑↓/戻る = 変更を捨てて1つ戻る
      }
      if (S.diag && k === 'Enter') {                        // 診断内ピンチ=自宅登録/削除(2度押し確認)
        var g0 = DIAG.raw || S.readyGeo;
        if (S.homeConfirm) {
          if (S.home) { S.home = null; lsDel('thud.home'); wpFlash('自宅を削除しました'); }
          else if (g0) { S.home = { la: g0.la, lo: g0.lo }; lsSet('thud.home', S.home); wpFlash('ここを自宅に登録(端末外に出ません)'); }
          S.homeConfirm = false;
        } else { S.homeConfirm = true; wpFlash(S.home ? 'もう一度ピンチで自宅を削除' : 'もう一度ピンチでここを自宅に'); }
        render(); return;
      }
      if (k === 'ArrowDown' && !S.diag) diagGeoLast = 0;    // 診断を開いた瞬間に測位
      if (S.diag && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        S.hmode = (S.hmode === 'inv') ? 'alpha' : 'inv';
        lsSet('thud.hmode', S.hmode); render(); return;
      }
      if (!S.diag && S.startCands && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        var nc = S.startCands.length;
        S.startIdx = (S.startIdx + (k === 'ArrowRight' ? 1 : nc - 1)) % nc;
        S.startManual = true; S.startSuggested = false; render(); return;
      }
      if (k === 'Enter') { if (S.startFailed) startAnyway(false); else beginStart(false); }
      if (k === 'ArrowUp' && !S.diag) {                     // ↑ = 目標ペース層(↓の診断と対にする)
        S.paceEdit = (S.paceGoal > 0) ? S.paceGoal : paceBase();
        render(); return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') {           // ↓=診断トグル / 診断中は↑でも閉じる
        S.diag = !S.diag;
        if (S.diag && DIAG.oriPerm === '-' && !SIM) {   // 未解決ならこのジェスチャーで再要求
          DIAG.retryN++; DIAG.reqMs = Date.now();
          reqPerm('DeviceOrientationEvent', 'ori');
        }
        render();
      }
      if (k === 'Escape') goBack();
      return;
    }
    if (S.mode === 'main') {
      if (k === 'ArrowLeft')  { S.panel = (S.panel + 4) % 5; if (S.panel === 4 && !S.wx) fetchWeather(); render(); }
      if (k === 'ArrowRight') { S.panel = (S.panel + 1) % 5; if (S.panel === 4 && !S.wx) fetchWeather(); render(); }
      if (k === 'ArrowUp')    { enterIdent(); }         // v2改定: ↑=同定モード(全パネル共通)
      if (k === 'ArrowDown')  { S.theme = (S.theme === 'w') ? 'y' : 'w'; applyTheme(); }
      if (k === 'Enter' && S.panel === 3) manualWp();   // WP確認は次WPパネル表示中のみ
      if (k === 'Escape') goBack();                       // → 終了(popstateでdoneへ)
      return;
    }
    if (S.mode === 'ident') {
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        S.identLayer = (S.identLayer === 'ground') ? 'sky' : 'ground';
        setNight(S.identLayer === 'sky' && S.sun && S.sun.sunset && nowMs() > S.sun.sunset.getTime());
        render(); return;
      }
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && S.identLayer === 'ground') {
        S.identFilter = (S.identFilter + (k === 'ArrowRight' ? 1 : 2)) % 3; render(); return;
      }
      if (k === 'Escape') { setNight(false); goBack(); }
      return;
    }
    if (S.mode === 'cere') {
      if (k === 'Enter') { try { history.replaceState({ s: 'ident' }, ''); } catch (e2) {} S.mode = 'ident'; S.identLayer = 'ground'; render(); return; }
      if (k === 'Escape') goBack();
      return;
    }
    if (S.mode === 'warn') {
      if (k === 'Enter')  { S.suppressUntil = nowMs() + 5 * 60000; goBack('suppress'); }
      if (k === 'Escape') goBack();                       // 60秒猶予はpopstate側で付与
      return;
    }
    if (S.mode === 'done') {
      if (k === 'Enter' || k === 'Escape') goBack();      // → select
    }
  });

  function handleSimKey(k) {
    var sim = Geo.sim;
    if (k === 'd' || k === 'D') { sim.offset = sim.offset ? 0 : 80; return true; }
    if (k === 'l' || k === 'L') { sim.lostUntil = Date.now() + 35000; return true; }
    if (k === 'a' || k === 'A') { sim.degraded = !sim.degraded; return true; }
    if (k === 't' || k === 'T') { sim.teleport = true; return true; }
    if (k === 'p' || k === 'P') { sim.paused = !sim.paused; return true; }
    if (k === 's' || k === 'S') { sim.mul = { 5: 20, 20: 60, 60: 5 }[sim.mul] || 20; return true; }
    if (k === 'n' || k === 'N') {
      if (S.sun && S.sun.sunset) simClockOff += (S.sun.sunset.getTime() - nowMs()) - 95 * 60000;
      return true;
    }
    if (k === 'j' || k === 'J') { sim.headOff = (sim.headOff || 0) - 15; return true; }
    if (k === 'k' || k === 'K') { sim.headOff = (sim.headOff || 0) + 15; return true; }
    if (k === 'g' || k === 'G') {          // 進捗もろとも終盤へ(テレポートではなく早送り)
      sim.along = Math.max(0, S.route.total - 150);
      S.along = sim.along; S.maxAlong = Math.max(S.maxAlong, sim.along);
      S.cursor = CORE.routePointAt(S.route, sim.along).seg;
      S.movingMin = Math.max(S.movingMin, (CORE.ctAt(S.route, sim.along) || 0) * 1.0);
      return true;
    }
    return false;
  }

  // PC検証用クリック(ガイド推奨: タップハンドラ並行実装)
  document.addEventListener('mousedown', function (e) {
    var x = e.clientX, y = e.clientY;
    var k;
    if (y > 545) k = 'Escape';
    else if (x < 190) k = 'ArrowLeft';
    else if (x > 410) k = 'ArrowRight';
    else k = 'Enter';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  });

  /* ================= 画面遷移ヘルパ ================= */
  var sensorWatchdog = null;
  var permPending = false;
  function requestSensorsThen(next) {
    if (S.sensorsReady) { next(); return; }
    if (permPending) return;               // 連打で requestPermission を二重発行しない
    permPending = true;
    S.perm = 'センサーの使用を許可してください…'; render();
    var done = false;
    var finish = function () {
      if (done) return; done = true;
      permPending = false;
      if (sensorWatchdog) { clearTimeout(sensorWatchdog); sensorWatchdog = null; }
      initHistory();               // 履歴の初期化は権限解決後が最初(公式ハング対策)
      S.sensorsReady = true; S.perm = '';
      startOrientation();          // 許可が終わってからリスナー装着
      next();
    };
    sensorWatchdog = setTimeout(finish, 20000);   // プロンプト応答の猶予。無応答でも先へ進める
    ensureSensors().then(finish, finish);         // ← keydown内から同期的に呼ばれる
  }

  function afterDisclaimer() {
    var a = lsGet('thud.active');
    if (a && Date.now() - a.savedAt < 24 * 3600000) {
      S.resumeData = a; S.mode = 'resume';
      pushScreen('resume');                 // バックジェスチャーで戻れるよう履歴を1段積む
    } else { lsDel('thud.active'); S.mode = 'select'; }
    render();
  }
  function doResume() {
    var a = S.resumeData; if (!a) { S.mode = 'select'; render(); return; }
    replaceScreen('ready'); S.mode = 'ready';           // 履歴: resume枠をreadyに置換
    var idx = 0;
    for (var i = 0; i < BUILT.length; i++) if (BUILT[i].id === a.routeId) idx = i;
    S.routeIdx = idx; S.route = BUILT[idx];
    if (a.rot > 0) {   // 回転した周回で保存されていた場合は同じ原点で復元
      var rn = '';
      for (var wi = 0; wi < BUILT[idx].wps.length; wi++) if (Math.abs(BUILT[idx].wps[wi].d - a.rot) < 40) rn = BUILT[idx].wps[wi].n;
      S.route = CORE.rotateLoop(BUILT[idx], a.rot, rn || '合流点');
    }
    S.rotOff = a.rot || 0;
    loadPaceGoal();
    S.startMs = a.startMs; S.movingMin = a.movingMin || 0; S.stopMin = a.stopMin || 0;
    S.along = a.along || 0; S.maxAlong = a.maxAlong || 0; S.cursor = a.cursor;
    S.wpPassed = a.wpPassed || {}; S.track = a.track || []; S.emaKmh = a.emaKmh || 0;
    if (SIM) Geo.sim.along = S.along;
    fetchWeather();
    beginStart(true);
  }
  function toReady() {
    S.route = BUILT[S.routeIdx];
    loadPaceGoal();                                        // 目標ペースはルート単位で永続
    S.sun = CORE.sunTimes(S.route.pts[0][0], S.route.pts[0][1], nowDate());
    if (SIM) { Geo.sim.along = 0; Geo.sim.offset = 0; }
    // 周回コースはスタートWPを選べる(GPSで最寄りをサジェスト)
    S.startCands = null; S.startIdx = 0; S.startManual = false; S.startSuggested = false; S.readyGeo = null;
    if (CORE.isLoop(S.route)) {
      var cands = [];
      for (var ci = 0; ci < S.route.wps.length; ci++) {
        var cw = S.route.wps[ci];
        if (cw.d < S.route.total - 1) cands.push(cw);   // goal重複は除く(d=0のstart含む)
      }
      if (cands.length >= 2) { S.startCands = cands; readyGeoPoll(); }
    }
    fetchWeather();
    prefetchTiles();                                     // 回廊タイル先読み(SWがTILESへ保存)
    pushScreen('ready'); S.mode = 'ready'; startTicker(); render();
  }
  function applyTheme() {
    document.body.className = (S.theme === 'w' ? 't-w' : '') + (S.night ? ' t-night' : '');
  }

  /* ================= 描画 ================= */
  var app = null;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function arrowSvg(id) {
    return '<svg id="' + id + '" viewBox="0 0 100 100" width="150" height="150">' +
      '<g id="' + id + '-g" transform="rotate(0 50 50)">' +
      '<path d="M50 6 L74 62 L50 48 L26 62 Z" fill="currentColor"/>' +
      '</g></svg>';
  }
  var arrowPending = false;
  function scheduleArrow() {
    if (arrowPending) return; arrowPending = true;
    requestAnimationFrame(function () { arrowPending = false; updateArrow(); });
  }
  function arrowTarget() {
    if (!S.proj) return null;
    if (S.dev && S.dev.state.deviated) {
      var p = CORE.routePointAt(S.route, S.proj.along);
      return { pt: p, lbl: '復帰方向' };
    }
    // 次WP直線方位は稜線で誤誘導し得るため、ルート120m先を指す(意図的仕様変更)
    var a = CORE.routePointAt(S.route, Math.min(S.route.total, S.along + 120));
    return { pt: a, lbl: 'ルート先' };
  }
  function updateArrow() {
    var g = document.getElementById('arw-g');
    if (!g || !S.lastFix) return;
    var tgt = arrowTarget(); if (!tgt) return;
    var fresh = (Date.now() - S.headingReal) < 3000;
    var wrap = document.getElementById('arw-wrap');
    if (!fresh || S.heading == null || !S.headingSettled) {  // F7: 誤方位を出すくらいなら消す
      if (wrap) wrap.style.visibility = 'hidden';
      var nl = document.getElementById('arw-na');
      if (nl) { nl.style.display = 'block';
        nl.textContent = (fresh && S.heading != null) ? '方位較正中… (頭をゆっくり左右に)' : '方位取得不可'; }
      return;
    }
    if (wrap) wrap.style.visibility = 'visible';
    var nl2 = document.getElementById('arw-na'); if (nl2) nl2.style.display = 'none';
    var brg = CORE.bearing([S.lastFix.la, S.lastFix.lo], [tgt.pt.la, tgt.pt.lo]);
    var rot = ((brg - S.heading) % 360 + 360) % 360;
    g.setAttribute('transform', 'rotate(' + rot.toFixed(0) + ' 50 50)');
  }

  function bandText() {                                   // ⑤帯: 優先度順に1件
    var t = nowMs();
    if (S.permDenied) return { c: 'acc1', s: '位置情報が未許可です' };
    var age = (Date.now() - S.lastFixReal) / 1000;
    if (S.lastFixReal && age > 30) return { c: 'acc1', s: 'GPS喪失 ' + Math.round(age) + '秒' };
    if (!S.lastFixReal && S.tracking) return { c: 'dim', s: 'GPS取得中…' };
    if (S.lastFix && S.lastFix.acc > 75) return { c: 'acc2', s: 'GPS精度低下 ±' + Math.round(S.lastFix.acc) + 'm' };
    if (S.suppressUntil > t) {
      var r = Math.ceil((S.suppressUntil - t) / 1000);
      return { c: 'acc2', s: '逸脱警告を抑制中 残' + Math.floor(r / 60) + ':' + ('0' + (r % 60)).slice(-2) };
    }
    if (S.wpFlashUntil > t) return { c: 'main-c', s: S.wpFlashMsg };
    if (S.ghostBehind != null && S.mode === 'main') return { c: 'dim', s: 'ゴースト後方 ' + S.ghostBehind + 'm' };
    if (S.lastFix && S.lastFix.acc != null) return { c: 'dim', s: '±' + Math.round(S.lastFix.acc) + 'm' + (SIM ? simBadge() : '') };
    return { c: 'dim', s: SIM ? simBadge() : '' };
  }
  function simBadge() {
    var s = Geo.sim;
    return '  [SIM ×' + s.mul + (s.paused ? ' 停止' : '') + (s.offset ? ' 逸脱' : '') + (s.degraded ? ' 低精度' : '') + ']';
  }

  function sunsetHtml() {
    if (!S.sun || !S.sun.sunset) return '<span class="dim">日没 --:--</span>';
    var remMin = (S.sun.sunset.getTime() - nowMs()) / 60000;
    var cls = remMin <= 30 ? 'acc1' : (remMin <= 90 ? 'acc2' : '');
    var rem = remMin > 0 ? '(残' + CORE.fmtDur(remMin) + ')' : '(日没後)';
    return '<span class="' + cls + '">日没 ' + CORE.fmtClock(S.sun.sunset) + ' ' + rem + '</span>';
  }

  /* ---- 同定モード(透視エンジン) ---- */
  function enterIdent() {
    if (!S.tracking) return;
    S.identLayer = 'ground';
    // 日没後に入ったら空レイヤ既定+夜パレット
    if (S.sun && S.sun.sunset && nowMs() > S.sun.sunset.getTime()) { S.identLayer = 'sky'; setNight(true); }
    pushScreen('ident'); S.mode = 'ident'; render();
  }
  function setNight(on) {
    S.night = on;
    document.body.className = (S.theme === 'w' ? 't-w' : '') + (on ? ' t-night' : '');
  }
  function identItems() {   // 現在地から見た方位レジストリ(山・POI・家・太陽・月)
    if (!S.lastFix) return null;
    var me = [S.lastFix.la, S.lastFix.lo];
    var items = [], reg = S.route.reg || [], i;
    var peaksDone = lsGet('thud.peaks') || {};
    for (i = 0; i < reg.length; i++) {
      var e = reg[i];
      if (S.identFilter === 1 && e.t !== 'peak' && e.t !== 'tower') continue;
      if (S.identFilter === 2 && (e.t === 'peak' || e.t === 'tower')) continue;
      var d = CORE.hav(me, [e.la, e.lo]);
      items.push({ n: e.n, t: e.t, vis: !!e.v, dist: d, el: e.el,
                   brg: CORE.bearing(me, [e.la, e.lo]),
                   trophy: e.t === 'peak' && !!peaksDone[e.n] });
    }
    if (S.home && S.identFilter !== 1) {
      items.push({ n: '家', t: 'home', vis: false, dist: CORE.hav(me, [S.home.la, S.home.lo]),
                   brg: CORE.bearing(me, [S.home.la, S.home.lo]), el: null, trophy: false });
    }
    var sa = ASTRO.sunAltAz(me[0], me[1], nowMs());
    if (sa.alt > -6) items.push({ n: '太陽', t: 'sun', vis: true, dist: null, brg: sa.az, alt: sa.alt });
    var mq = ASTRO.moonEq(nowMs());
    var ma = ASTRO.altAz(mq.ra, mq.dec, me[0], me[1], nowMs());
    if (ma.alt > 0) items.push({ n: '月', t: 'moon', vis: true, dist: null, brg: ma.az, alt: ma.alt });
    if (S.sun && S.sun.sunset && nowMs() < S.sun.sunset.getTime()) {   // ご来光/日没の方位マーカー
      var ss = ASTRO.sunAltAz(me[0], me[1], S.sun.sunset.getTime());
      items.push({ n: '日没 ' + CORE.fmtClock(S.sun.sunset), t: 'sunset', vis: false, dist: null, brg: ss.az });
    }
    return items;
  }
  function stripX(diff, half) { return 300 + diff * (270 / half); }
  function scrIdentGround() {
    var ht = headingTrue();
    if (!S.lastFix) return identShell('<div class="abs ctr" style="top:250px"><span class="eta1 dim">GPS待ち…</span></div>');
    if (ht == null || !S.headingSettled) {
      return identShell('<div class="abs ctr" style="top:250px"><span class="eta1 dim">方位較正中…</span>' +
        '<div class="sub dim" style="margin-top:14px">頭をゆっくり左右に振ってください</div></div>');
    }
    var items = identItems() || [];
    var HALF = 30, shown = [];
    for (var i = 0; i < items.length; i++) {
      var d = CORE.angDiff(items[i].brg, ht);
      if (Math.abs(d) <= HALF) { items[i].diff = d; shown.push(items[i]); }
    }
    shown.sort(function (x, y) { return Math.abs(x.diff) - Math.abs(y.diff); });
    var svg = '<svg viewBox="0 0 600 340" width="600" height="340">';
    svg += '<line x1="30" y1="250" x2="570" y2="250" stroke="#6b675c" stroke-width="2"/>';
    for (var t = -30; t <= 30; t += 10) {   // 方位目盛
      var x = stripX(t, HALF);
      var lbl = Math.round(((ht + t) % 360 + 360) % 360);
      svg += '<line x1="' + x + '" y1="244" x2="' + x + '" y2="256" stroke="#6b675c" stroke-width="2"/>';
      svg += '<text x="' + x + '" y="278" fill="#6b675c" font-size="15" text-anchor="middle" font-family="inherit">' + lbl + '°</text>';
    }
    var labels = '';
    for (i = 0; i < Math.min(shown.length, 6); i++) {
      var it = shown[i], x2 = stripX(it.diff, HALF);
      var focus = i === 0;
      var col = it.trophy ? '#ffd83b' : (focus ? '#f5f1e6' : '#6b675c');
      var dash = it.vis ? '' : ' stroke-dasharray="4 5"';
      svg += '<line x1="' + x2 + '" y1="250" x2="' + x2 + '" y2="' + (150 - i * 12) + '" stroke="' + col + '" stroke-width="' + (focus ? 3 : 2) + '"' + dash + '/>';
      if (i < 3) {
        var tag = (it.trophy ? '★' : '') + it.n;
        svg += '<text x="' + x2 + '" y="' + (140 - i * 12) + '" fill="' + col + '" font-size="' + (focus ? 24 : 17) + '" text-anchor="middle" font-family="inherit"' + (focus && it.trophy ? ' font-weight="bold"' : '') + '>' + tag + '</text>';
      }
    }
    svg += labels + '</svg>';
    var c = shown[0], detail = '';
    if (c) {
      detail = '<div class="abs ctr" style="top:352px"><span class="eta1 main-c">' + (c.trophy ? '★' : '') + esc(c.n) + '</span>' +
        '<div class="ct1 dim">' + (c.el != null ? c.el + 'm ・ ' : '') + (c.dist != null ? CORE.fmtKm(c.dist) : (c.alt != null ? '高度' + Math.round(c.alt) + '°' : '')) +
        (c.vis ? ' <span class="sub">[可視]</span>' : ' <span class="sub dim">[この方向・透視]</span>') + '</div></div>';
    } else {
      detail = '<div class="abs ctr" style="top:352px"><span class="ct1 dim">この方向に登録対象なし</span></div>';
    }
    var f = ['全部', '山', '施設'][S.identFilter];
    return identShell('<div class="abs" style="top:36px">' + svg + '</div>' + detail +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">←→ ' + f + ' ／ ↑↓ 空レイヤ ／ 戻る</span></div>');
  }
  function scrIdentSky() {
    var ht = headingTrue();
    if (ht == null || !S.headingSettled || !S.lastFix) {
      return identShell('<div class="abs ctr" style="top:250px"><span class="eta1 dim">方位較正中…</span></div>');
    }
    var me = [S.lastFix.la, S.lastFix.lo], t = nowMs(), HALF = 30;
    var svg = '<svg viewBox="0 0 600 430" width="600" height="430">';
    svg += '<line x1="30" y1="400" x2="570" y2="400" stroke="#6b675c" stroke-width="2"/>';
    function sy(alt) { return 400 - Math.max(0, Math.min(70, alt)) * (340 / 70); }
    var pos = {}, i, vis = 0;
    for (i = 0; i < STARS.s.length; i++) {
      var s = STARS.s[i];
      var aa = ASTRO.altAz(s[1], s[2], me[0], me[1], t);
      var dd = CORE.angDiff(aa.az, ht);
      if (aa.alt < -1 || Math.abs(dd) > HALF) continue;
      pos[i] = [stripX(dd, HALF), sy(aa.alt)];
      vis++;
    }
    var ck; // 星座線(両端が視界内のもの)
    for (ck in STARS.c) {
      var lines = STARS.c[ck].l;
      for (i = 0; i < lines.length; i++) {
        var pA = pos[lines[i][0]], pB = pos[lines[i][1]];
        if (pA && pB) svg += '<line x1="' + pA[0].toFixed(0) + '" y1="' + pA[1].toFixed(0) + '" x2="' + pB[0].toFixed(0) + '" y2="' + pB[1].toFixed(0) + '" stroke="#6b675c" stroke-width="1.5"/>';
      }
    }
    var named = [];
    for (i = 0; i < STARS.s.length; i++) {
      if (!pos[i]) continue;
      var st = STARS.s[i], r = st[3] < 0.5 ? 5 : (st[3] < 1.6 ? 3.5 : 2.2);
      svg += '<circle cx="' + pos[i][0].toFixed(0) + '" cy="' + pos[i][1].toFixed(0) + '" r="' + r + '" fill="currentColor"/>';
      if (st[3] < 1.3) named.push([pos[i], st[0]]);
    }
    var pls = ASTRO.planets(t).concat([(function () { var m = ASTRO.moonEq(t); return { n: '月', ra: m.ra, dec: m.dec, t: 'moon' }; })()]);
    for (i = 0; i < pls.length; i++) {
      var pa = ASTRO.altAz(pls[i].ra, pls[i].dec, me[0], me[1], t);
      var pd = CORE.angDiff(pa.az, ht);
      if (pa.alt < 0 || Math.abs(pd) > HALF) continue;
      var xx = stripX(pd, HALF), yy = sy(pa.alt);
      svg += '<circle cx="' + xx.toFixed(0) + '" cy="' + yy.toFixed(0) + '" r="5" fill="none" stroke="currentColor" stroke-width="2"/>';
      named.push([[xx, yy], pls[i].n]);
    }
    for (i = 0; i < Math.min(named.length, 5); i++) {
      svg += '<text x="' + named[i][0][0].toFixed(0) + '" y="' + (named[i][0][1] - 10).toFixed(0) + '" fill="currentColor" font-size="17" text-anchor="middle" font-family="inherit">' + named[i][1] + '</text>';
    }
    svg += '</svg>';
    return identShell('<div class="abs" style="top:10px;color:' + (S.night ? '#b04040' : '#f5f1e6') + '">' + svg + '</div>' +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">' + vis + '星 ／ ↑↓ 地上へ ／ 夜間はシステム輝度を最低に</span></div>');
  }
  function identShell(inner) {
    var band = bandText();
    return inner + '<div class="abs z-band ' + band.c + '">' + esc(band.s) + '</div>';
  }

  /* ---- 各画面 ---- */
  function scrDisclaimer() {
    return '<div class="overlay ctr"><div class="ov-title acc2">登山HUD (試作)</div>' +
      '<div class="ov-body">本アプリは<b>補助</b>です。<br>地図・コンパス・スマホを<br>必ず携行してください。<br><br>' +
      '緊急時はスマホで<br><b>110 / 119</b> へ通報。</div>' +
      '<div class="hint ' + (S.perm ? 'dim' : 'main-c') + '" style="margin-top:44px">' +
      (S.perm ? esc(S.perm) : 'ピンチで了承して開始') + '</div></div>';
  }
  function scrResume() {
    var a = S.resumeData;
    var name = ''; for (var i = 0; i < BUILT.length; i++) if (BUILT[i].id === a.routeId) name = BUILT[i].name;
    return '<div class="overlay ctr"><div class="ov-title">前回の山行があります</div>' +
      '<div class="ov-body">' + esc(name) + '<br>進捗 ' + CORE.fmtKm(a.maxAlong || 0) + '</div>' +
      '<div class="hint" style="margin-top:50px"><span class="main-c">ピンチ: 再開</span>' +
      '<span class="dim">　／　戻る: 破棄</span></div></div>';
  }
  function scrSelect() {
    var r = BUILT[S.routeIdx];
    var dots = '';
    for (var i = 0; i < BUILT.length; i++) dots += (i === S.routeIdx ? '●' : '○');
    return '<div class="abs ctr" style="top:34px"><span class="screen-title dim">ルート選択</span></div>' +
      '<div class="abs" style="top:150px;left:20px" ><span class="navlr dim">‹</span></div>' +
      '<div class="abs" style="top:150px;right:20px;left:auto;width:40px"><span class="navlr dim">›</span></div>' +
      '<div class="abs ctr" style="top:120px;padding:0 80px"><span class="route-name main-c">' + esc(r.name) + '</span></div>' +
      '<div class="abs ctr" style="top:230px"><div class="stat-row">距離 ' + CORE.fmtKm(r.total) +
      '　登り ' + Math.round(r.gainTotal) + 'm</div>' +
      '<div class="stat-row">標準CT ' + CORE.fmtDur(r.ctTotal) + '</div>' +
      (r.demo ? '<div class="stat-row acc2 sub" style="margin-top:8px">※デモ(架空ルート)</div>' : '') + '</div>' +
      '<div class="abs ctr" style="top:400px"><span class="dots dim">' + dots + '</span></div>' +
      '<div class="abs ctr" style="bottom:28px"><span class="hint dim">←→ 選択　ピンチ 決定</span></div>' +
      '<div class="abs" style="bottom:6px;right:10px;left:auto;text-align:right"><span class="sub dim">build ' +
      (typeof BUILD !== 'undefined' ? BUILD : '?') + (SIM ? ' SIM' : '') + '</span></div>';
  }
  function scrReady() {
    var r = S.route;
    var set = S.sun && S.sun.sunset ? CORE.fmtClock(S.sun.sunset) : '--:--';
    return '<div class="abs ctr" style="top:40px"><span class="route-name">' + esc(r.name) + '</span></div>' +
      (S.paceEdit != null ? '' :                            // 目標ペース層とは同じ帯を使うので排他
        '<div class="abs" style="top:150px;padding:0 110px"><div class="frame">' +
        '<div class="stat-row">距離　　 ' + CORE.fmtKm(r.total) + '</div>' +
        '<div class="stat-row">獲得標高 +' + Math.round(r.gainTotal) + 'm</div>' +
        '<div class="stat-row">標準CT　 ' + CORE.fmtDur(r.ctTotal) + '</div>' +
        '<div class="stat-row">日没　　 ' + set + '</div></div></div>') +
      startSelHtml() + paceHtml() +
      (S.perm ? '<div class="abs ctr" style="top:420px;padding:0 40px"><span class="sub acc2">' + esc(S.perm) + '</span></div>' : '') +
      '<div class="abs ctr" style="bottom:28px">' + (S.paceEdit != null
        ? '<span class="hint main-c">ピンチで確定</span><span class="hint dim">　◂ ▸ で5分きざみ　戻る: やめる</span>'
        : '<span class="hint ' + (S.starting ? 'dim' : 'main-c') + '">' +
          (S.starting ? '確認中…' : (S.startFailed ? 'ピンチでGPSなし開始' : 'ピンチで計測開始')) +
          '</span><span class="hint dim">　戻る: 選択へ</span>') + '</div>' +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">' +
      (S.diag || S.paceEdit != null ? '' :
        (S.home ? '↓ センサー診断(ピンチで自宅削除)' + (SIM ? '' : ' ／ PC検証は ?sim=1')
                : '<span class="main-c">↓ ここを自宅にする</span> ／ センサー診断' + (SIM ? '' : ' ／ ?sim=1'))) +
      '</span></div>' +
      '<div class="abs ctr" style="bottom:82px"><span class="sub dim">' +
      (S.diag || S.paceEdit != null ? '' :
        '<span class="' + (S.paceGoal > 0 ? 'acc2' : 'dim') + '">↑ 目標ペース' +
        (S.paceGoal > 0 ? ' ' + CORE.fmtDur(S.paceGoal) + ' 設定中' : '(未設定)') + '</span>') +
      '</span></div>' + diagHtml();
  }
  function diagHtml() {
    if (!S.diag) return '';
    var v = function (x) { return x == null ? 'null' : (typeof x === 'number' ? Math.round(x) : String(x)); };
    var g = DIAG.raw;
    var gpsLine = g
      ? g.la.toFixed(5) + ', ' + g.lo.toFixed(5) + ' ±' + Math.round(g.acc) + 'm (' + Math.round((Date.now() - g.t) / 1000) + '秒前)'
      : (DIAG.rawErr || '測位中…');
    var startLine = '';
    if (g && S.route) {
      var sp = [S.route.pts[0][0], S.route.pts[0][1]];
      startLine = '<div>起点まで ' + CORE.fmtKm(CORE.hav([g.la, g.lo], sp)) +
        ' 方位' + Math.round(CORE.bearing([g.la, g.lo], sp)) + '°　w:' + DIAG.fixW + ' p:' + DIAG.fixP + '</div>';
    }
    var homeAct = S.homeConfirm
      ? (S.home ? 'もう一度ピンチで自宅を削除' : 'もう一度ピンチでここを自宅に')
      : (S.home ? 'ピンチ: 自宅を削除(登録済み)' : 'ピンチ: ここを自宅に登録');
    return '<div class="abs" style="top:308px;padding:0 36px"><div class="frame" style="font-size:16px;line-height:1.42">' +
      '<div class="' + (S.homeConfirm ? 'acc2' : 'main-c') + '">' + homeAct + '</div>' +
      '<div>権限 ori: ' + esc(DIAG.oriFn) + ' → ' + esc(DIAG.oriPerm) +
      (DIAG.oriPerm === '-' && DIAG.reqMs ? '(' + Math.round((Date.now() - DIAG.reqMs) / 1000) + '秒応答なし)' : '') +
      (DIAG.retryN ? ' 再要求' + DIAG.retryN : '') +
      ' ／ mot: ' + esc(DIAG.motFn) + '</div>' +
      '<div>受信 abs:' + DIAG.absN + ' 通常:' + DIAG.oriN + ' motion:' + DIAG.motN + '</div>' +
      '<div>alpha:' + v(DIAG.alpha) + ' wkc:' + v(DIAG.wkc) + ' absolute:' + v(DIAG.absFlag) +
      ' → heading:' + v(S.heading) + '</div>' +
      '<div>変換: <span class="main-c">' + (S.hmode === 'inv' ? '360−α' : 'α直') + '</span>' +
      ' (←→切替) 東向きでα≈90ならα直が正</div>' +
      '<div>GPS: <span class="main-c">' + gpsLine + '</span></div>' + startLine +
      '<div>β:' + v(DIAG.beta) + ' γ:' + v(DIAG.gamma) + '  真方位:' + v(headingTrue()) + '°(偏角' + ((S.route && S.route.dec) || 7.5) + '西)</div>' +
      '<div class="dim">reg:' + ((S.route && S.route.reg) ? S.route.reg.length : 0) + '件 星:' + (typeof STARS !== 'undefined' ? STARS.s.length : 0) + ' Lap:' + S.lap + '</div>' +
      '</div></div>';
  }
  function startSelHtml() {
    if (!S.startCands || S.diag || S.paceEdit != null) return '';
    var w = S.startCands[S.startIdx];
    var d = candDist(S.startIdx);
    var sub = S.startSuggested ? '現在地の最寄り' + (d != null ? ' (' + CORE.fmtKm(d) + ')' : '')
            : (d != null ? '現在地から ' + CORE.fmtKm(d) : 'GPSで最寄りを提案します');
    return '<div class="abs ctr" style="top:352px">' +
      '<span class="sub dim">スタート地点</span><br>' +
      '<span class="eta1"><span class="dim">◂ </span><span class="main-c">' + esc(w.n) + '</span><span class="dim"> ▸</span></span><br>' +
      '<span class="sub ' + (S.startSuggested ? 'acc2' : 'dim') + '">' + sub + '</span></div>';
  }
  function panelHeader(names) {
    var h = '';
    for (var i = 0; i < names.length; i++) {
      h += '<span class="' + (i === S.panel ? 'main-c' : 'dim') + '">' + names[i] + '</span>' + (i < names.length - 1 ? '<span class="dim"> ・ </span>' : '');
    }
    return '<div class="abs z-head"><span class="dim">◂ </span>' + h + '<span class="dim"> ▸</span></div>';
  }
  function scrMain() {
    var head = panelHeader(['進捗', '断面', '地形図', '次WP', '天気']);
    var band = bandText();
    var bandHtml = '<div class="abs z-band ' + band.c + '">' + esc(band.s) + '</div>';
    var ov = ghostOverlayHtml();
    if (S.panel === 0) return head + panelProgress() + ov + bandHtml;
    if (S.panel === 1) return head + panelProfile() + ov + bandHtml;
    if (S.panel === 2) return head + panelMap() + ov + bandHtml;
    if (S.panel === 3) return head + panelWp() + bandHtml;
    return head + panelWx() + bandHtml;
  }
  function staleInfo() {
    var s = S.lastGoodFixReal ? (Date.now() - S.lastGoodFixReal) / 1000 : Infinity;
    return { sec: s, txt: s > 90 ? '(' + Math.round(s / 60) + '分前の位置)' : '' };
  }
  function panelProgress() {
    // 有効な測位が一度も無い/10分以上古い → 数字を出さない(古い値を確信的に出さない)
    var st = staleInfo();
    if (!S.proj || st.sec > 600) {
      return '<div class="abs z-big ctr"><div class="big2 dim" style="margin-top:40px">GPS待ち…</div>' +
        '<div class="sub dim" style="margin-top:14px">' +
        (S.lastFix && S.lastFix.acc > 75 ? '精度不足 ±' + Math.round(S.lastFix.acc) + 'm (屋内では改善しません)' : '測位待ちです') +
        '</div></div>' +
        '<div class="abs z-eta ctr"><div class="eta2">' + sunsetHtml() + '</div></div>' +
        '<div class="abs z-ct ctr"><span class="ct1 dim">残距離は測位後に表示</span></div>';
    }
    // 逸脱中(FSM確定 or 射影距離150m超)は沿い距離でなく復帰情報を出す
    if (S.dev && (S.dev.state.deviated || (S.proj && S.proj.dist > 150))) {
      var dd = S.dev.state.dist;
      return '<div class="abs z-arrow ctr"><div class="arrow-wrap acc2" id="arw-wrap">' + arrowSvg('arw') + '</div>' +
        '<div class="arrow-lbl dim" id="arw-na" style="display:none">方位取得不可</div>' +
        '<div class="arrow-lbl acc2">' + (dd > 2000 ? 'ルート方向' : '復帰方向') + '</div></div>' +
        '<div class="abs z-big ctr"><div class="sub acc2">ルートまで</div>' +
        '<div class="big1" style="color:#f5a11c">' + CORE.fmtKm(dd) + '</div></div>' +
        '<div class="abs z-eta ctr"><div class="eta2">' + sunsetHtml() + '</div></div>' +
        '<div class="abs z-ct ctr"><span class="ct1 dim">残距離・ETAはルート復帰後に表示' + (st.txt ? ' ' + st.txt : '') + '</span></div>';
    }
    var rem = CORE.remaining(S.route, S.along);
    var eta = CORE.etaRemainMin(S.route, S.along, S.movingMin, S.emaKmh);
    var etaTxt = eta.min != null ? CORE.fmtClock(new Date(nowMs() + eta.min * 60000)) : '--:--';
    var ct = CORE.ctAt(S.route, S.along);
    var ctTxt = (ct != null && ct > 5) ? 'CT ' + CORE.fmtDiff(S.movingMin - ct) : 'CT --';
    if (urban) {
      var lastLap = S.lapTimes.length ? CORE.fmtDur(S.lapTimes[S.lapTimes.length - 1] / 60) : '--';
      ctTxt = 'Lap' + S.lap + ' ・ 前Lap ' + lastLap;
    }
    var pace = S.emaKmh ? S.emaKmh.toFixed(1) + 'km/h' : '--km/h';
    var urban = S.route.domain === 'urban';
    var big2 = urban
      ? (S.emaKmh ? S.emaKmh.toFixed(1) + 'km/h' : '--km/h') + (S.lap > 1 ? ' ・ Lap' + S.lap : '')
      : '↑' + Math.round(rem.gain) + 'm';
    return '<div class="abs z-arrow ctr"><div class="arrow-wrap main-c" id="arw-wrap">' + arrowSvg('arw') + '</div>' +
      '<div class="arrow-lbl dim" id="arw-na" style="display:none">方位取得不可</div>' +
      '<div class="arrow-lbl dim">' + (S.dev && S.dev.state.deviated ? '<span class="acc1">復帰方向</span>' : 'ルート先') + '</div></div>' +
      '<div class="abs z-big ctr"><div class="big1 ' + (st.sec > 90 ? 'dim' : 'main-c') + '">残 ' + CORE.fmtKm(rem.dist) + '</div>' +
      '<div class="big2 ' + (st.sec > 90 ? 'dim' : 'main-c') + '">' + big2 +
      (st.txt ? ' <span class="sub acc2">' + st.txt + '</span>' : '') + '</div></div>' +
      '<div class="abs z-eta ctr"><div class="eta1">ETA ' + etaTxt + '</div>' +
      '<div class="eta2">' + sunsetHtml() + '</div></div>' +
      '<div class="abs z-ct ctr"><span class="ct1 dim">' + ctTxt + (urban ? '' : ' ・ ' + pace) + (S.moving ? '' : ' <span class="acc2">停止中</span>') + '</span></div>';
  }
  function offRouteNow() {
    return !!(S.dev && (S.dev.state.deviated || (S.proj && S.proj.dist > 150)));
  }
  function panelWp() {
    var st = staleInfo();
    if (!S.proj || st.sec > 600) {
      return '<div class="abs ctr" style="top:220px"><span class="eta1 dim">GPS待ち…</span>' +
        '<div class="sub dim" style="margin-top:14px">WPまでの距離は測位後に表示</div></div>';
    }
    if (offRouteNow()) {                                  // ルート外: 誤解を招く数値は一切出さない
      return '<div class="abs ctr" style="top:200px"><span class="eta1 acc2">ルート外</span>' +
        '<div class="sub dim" style="margin-top:16px">WPまでの距離はルート復帰後に表示</div></div>';
    }
    var w = nextWp();
    if (!w) return '<div class="abs ctr" style="top:220px"><span class="eta1 dim">この先のWPなし</span></div>';
    var distTo = Math.max(0, w.d - S.along);
    var p = CORE.routePointAt(S.route, w.d);
    var el = S.route.pts[p.seg] ? Math.round(S.route.pts[p.seg][2]) : null;
    var tmap = { water: '水場', hut: '小屋', junction: '分岐', peak: '山頂', escape: '分岐', goal: 'ゴール', wp: '' };
    var esc2 = (w.t === 'escape') ? '<div class="eta2 acc2">撤退路あり</div>' : '';
    var offNote = st.txt ? '<div class="abs ctr" style="top:70px"><span class="sub acc2">' + st.txt + '</span></div>' : '';
    return offNote + '<div class="abs ctr" style="top:110px"><div class="sub dim">次のポイント' + (tmap[w.t] ? ' [' + tmap[w.t] + ']' : '') + '</div>' +
      '<div class="route-name" style="margin-top:10px">' + esc(w.n) + '</div></div>' +
      '<div class="abs ctr" style="top:250px"><div class="big1 main-c">あと ' + CORE.fmtKm(distTo) + '</div>' +
      (el != null ? '<div class="eta2 dim" style="margin-top:14px">標高 約' + el + 'm</div>' : '') + esc2 + '</div>' +
      '<div class="abs ctr" style="top:470px"><span class="sub dim">ピンチ: 通過を手動確認</span></div>';
  }
  function ghostAlongNow() {   // 背中/ゴーストの現在沿道位置
    if (!S.tracking) return null;
    var g = null;
    if (S.ghostSrc === 'lap1' && S.ghost && S.ghost.samples) {          // 当日1周目の再生
      var el = (nowMs() - S.lapStartMs) / 1000;
      var ss = S.ghost.samples;
      for (var i = 0; i < ss.length; i++) { if (ss[i][0] >= el) { g = ss[i][1]; break; } }
      if (g == null) g = ss.length ? ss[ss.length - 1][1] : null;
    } else if (S.ghostSrc === 'last' && S.ghost && S.ghost.samples) {    // 前回の自分の再生
      var el2 = (nowMs() - S.startMs) / 1000;
      var ss2 = S.ghost.samples;
      for (var j = 0; j < ss2.length; j++) { if (ss2[j][0] >= el2) { g = ss2[j][1]; break; } }
      if (g == null) g = ss2.length ? ss2[ss2.length - 1][1] : null;
    } else if (S.ghostSrc === 'pace' && S.paceGoal > 0) {                // N8: 等速の仮想走者
      var t0 = isLoopRoute() ? (S.lapStartMs || S.startMs) : S.startMs;  // 周回は1周ごとに走り直す
      var el3 = (nowMs() - t0) / 60000;
      g = Math.max(0, Math.min(S.route.total, S.route.total * (el3 / S.paceGoal)));
    } else {                                                            // 標準CT歩行者
      g = CORE.ctInverse(S.route, (nowMs() - S.startMs) / 60000);
    }
    return g;
  }

  /* ---- N8: 目標ペース(等速仮想走者)の設定 ---- */
  var PACE_STEP = 5;                                       // 分。長押しが使えないので粗めに刻む
  function paceKey() { return 'thud.paceGoal.' + (S.route ? S.route.id : '-'); }
  function paceBase() {                                    // 基準=標準CT(無ければ4km/h換算)
    var r = S.route;
    if (!r) return 60;
    var b = (r.ctTotal && r.ctTotal > 10) ? r.ctTotal : (r.total / 4000) * 60;
    return Math.max(PACE_STEP, Math.round(b / PACE_STEP) * PACE_STEP);
  }
  function paceRange() { var b = paceBase();               // 下限より下は「設定しない」(=0)
    return [Math.max(PACE_STEP, Math.round(b * 0.4 / PACE_STEP) * PACE_STEP),
            Math.round(b * 1.6 / PACE_STEP) * PACE_STEP]; }
  function loadPaceGoal() {
    var v = lsGet(paceKey());
    S.paceGoal = (typeof v === 'number' && v > 0) ? v : null;
    S.paceEdit = null;
  }
  function paceHtml() {
    if (S.paceEdit == null) return '';
    var base = paceBase(), off = (S.paceEdit === 0);
    var kmh = off ? 0 : (S.route.total / 1000) / (S.paceEdit / 60);
    var vs = (S.paceEdit === base) ? '標準CTと同じ'
           : '標準CT ' + CORE.fmtDur(base) + ' 比 ' + CORE.fmtDiff(S.paceEdit - base);
    return '<div class="abs" style="top:170px;padding:0 70px"><div class="frame ctr">' +
      '<div class="sub dim">' + (isLoopRoute() ? '1周の目標タイム' : '目標タイム') + '(等速の仮想走者)</div>' +
      '<div class="stat-row"><span class="dim">◂ </span><span class="' + (off ? 'dim' : 'main-c') + '">' +
      (off ? '設定しない' : CORE.fmtDur(S.paceEdit)) + '</span><span class="dim"> ▸</span></div>' +
      '<div class="sub dim">' + (off
        ? 'ゴーストは前回の自分／標準CT'
        : vs + '　平均 ' + kmh.toFixed(1) + 'km/h') +
      '</div></div></div>';
  }
  function panelProfile() {   // 断面図: 数字を物語に(v2 N4)
    var r = S.route, W = 520, H = 260, pad = 10;
    var st = staleInfo();
    var eMin = 1e9, eMax = -1e9, i;
    for (i = 0; i < r.pts.length; i++) { eMin = Math.min(eMin, r.pts[i][2]); eMax = Math.max(eMax, r.pts[i][2]); }
    var eSpan = Math.max(eMax - eMin, 30);
    function px(along, el) {
      return [(pad + (W - 2 * pad) * along / r.total).toFixed(1),
              (H - pad - (H - 2 * pad) * (el - eMin) / eSpan).toFixed(1)];
    }
    var dTodo = '', dDone = '', splitAlong = S.proj ? S.along : 0;
    for (i = 0; i < r.pts.length; i++) {
      var q = px(r.cum[i], r.pts[i][2]);
      var seg = (r.cum[i] <= splitAlong) ? 'done' : 'todo';
      if (seg === 'done') dDone += (dDone ? 'L' : 'M') + q[0] + ' ' + q[1];
      else dTodo += (dTodo ? 'L' : 'M') + q[0] + ' ' + q[1];
    }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">';
    if (dTodo) svg += '<path d="' + dTodo + '" fill="none" stroke="#ffd83b" stroke-width="3"/>';
    if (dDone) svg += '<path d="' + dDone + '" fill="none" stroke="#6b675c" stroke-width="3"/>';
    for (i = 0; i < r.wps.length; i++) {
      var w2 = r.wps[i];
      var qe = px(w2.d, r.pts[CORE.routePointAt(r, w2.d).seg][2]);
      svg += '<circle cx="' + qe[0] + '" cy="' + qe[1] + '" r="4" fill="#6b675c"/>';
    }
    var gA = ghostAlongNow();
    if (gA != null) {
      var gq = px(gA, r.pts[CORE.routePointAt(r, gA).seg][2]);
      svg += '<circle cx="' + gq[0] + '" cy="' + gq[1] + '" r="6" fill="none" stroke="#6b675c" stroke-width="3"/>';
    }
    if (S.proj && st.sec < 600) {
      var mq = px(S.along, r.pts[CORE.routePointAt(r, S.along).seg][2]);
      svg += '<circle cx="' + mq[0] + '" cy="' + mq[1] + '" r="7" fill="#ffd83b"/>';
    }
    svg += '</svg>';
    var diff;
    if (S.ghostSrc === 'pace' && S.paceGoal > 0) {          // 目標ペースは等速なので通過予定時刻と直接比べる
      var pt0 = isLoopRoute() ? (S.lapStartMs || S.startMs) : S.startMs;
      var due = S.paceGoal * (S.along / r.total);
      diff = S.proj ? CORE.fmtDiff((nowMs() - pt0) / 60000 - due) : '--';
    } else {
      var ct = CORE.ctAt(r, S.along);
      diff = (ct != null && ct > 5) ? CORE.fmtDiff(((nowMs() - S.startMs) / 60000) - ct) : '--';
    }
    var gLbl = { ct: '標準CT', lap1: '1周目の自分', last: '前回の自分', pace: '目標ペース' }[S.ghostSrc] || '標準CT';
    return '<div class="abs ctr" style="top:60px">' + svg + '</div>' +
      '<div class="abs ctr" style="top:340px"><span class="eta1">' +
      Math.round(S.proj ? r.pts[CORE.routePointAt(r, S.along).seg][2] : r.pts[0][2]) + 'm</span>' +
      '<span class="dim ct1"> ／ 最高 ' + Math.round(eMax) + 'm</span></div>' +
      '<div class="abs ctr" style="top:392px"><span class="ct1 dim">ゴースト(' + gLbl + ') ' + diff + '</span></div>';
  }

  /* ---- 地形レイヤ(N2: 地理院陰影起伏を反転して尾根谷だけ光らせる) ---- */
  var terrCache = {};   // key → {url, fail}
  function lon2tx(lo, z) { return (lo + 180) / 360 * Math.pow(2, z); }
  function lat2ty(la, z) {
    var r = la * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function tx2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function ty2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function routeTiles(route, z, buf) {   // 回廊タイル一覧(先読み用)
    var seen = {}, out = [];
    for (var i = 0; i < route.pts.length; i++) {
      var tx = Math.floor(lon2tx(route.pts[i][1], z)), ty = Math.floor(lat2ty(route.pts[i][0], z));
      for (var dx = -buf; dx <= buf; dx++) for (var dy = -buf; dy <= buf; dy++) {
        var k = (tx + dx) + '/' + (ty + dy);
        if (!seen[k]) { seen[k] = 1; out.push([tx + dx, ty + dy]); }
      }
    }
    return out;
  }
  function tileUrl(z, x, y) { return 'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/' + z + '/' + x + '/' + y + '.png'; }
  function prefetchTiles() {
    if (SIM || typeof fetch !== 'function') return;
    try {
      var ts = routeTiles(S.route, 13, 0).slice(0, 40);
      for (var i = 0; i < ts.length; i++) fetch(tileUrl(13, ts[i][0], ts[i][1]))['catch'](function () {});
    } catch (e) {}
  }
  function buildTerrain(key, geo, W, H) {   // geo: {px(lo,la)→[x,y], minLa..} 相当のマッパ
    var st = terrCache[key];
    if (st) return;
    terrCache[key] = { url: null, fail: false };
    try {
      var z = 13;
      var x0 = Math.floor(lon2tx(geo.minLo, z)), x1 = Math.floor(lon2tx(geo.maxLo, z));
      var y0 = Math.floor(lat2ty(geo.maxLa, z)), y1 = Math.floor(lat2ty(geo.minLa, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 12) { terrCache[key].fail = true; return; }
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      if (!ctx) { terrCache[key].fail = true; return; }
      var pending = 0, failed = false;
      var finish = function () {
        if (failed) { terrCache[key].fail = true; return; }
        try {
          var img = ctx.getImageData(0, 0, W, H), d = img.data;
          for (var i = 0; i < d.length; i += 4) {
            var v = 255 - d[i];                             // 反転: 陰影(暗)→光
            d[i] = d[i + 1] = d[i + 2] = Math.round(v * 0.7);
            d[i + 3] = Math.min(255, v * 1.5);              // 白紙→透明(黒背景死守)
          }
          ctx.putImageData(img, 0, 0);
          terrCache[key].url = cv.toDataURL();
          render();
        } catch (e2) { terrCache[key].fail = true; render(); }
      };
      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          (function (tx, ty) {
            pending++;
            var im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = function () {
              try {
                var pNW = geo.px(tx2lon(tx, z), ty2lat(ty, z));
                var pSE = geo.px(tx2lon(tx + 1, z), ty2lat(ty + 1, z));
                ctx.drawImage(im, +pNW[0], +pNW[1], pSE[0] - pNW[0], pSE[1] - pNW[1]);
              } catch (e3) { failed = true; }
              if (--pending === 0) finish();
            };
            im.onerror = function () { if (--pending === 0) finish(); }; // 欠けは許容(未取得域は線図)
            im.src = tileUrl(z, tx, ty);
          })(tx, ty);
        }
      }
      if (pending === 0) terrCache[key].fail = true;
    } catch (e) { terrCache[key].fail = true; }
  }

  // ルート形状図: 地図タイルは出さない(非ゴール)が、線と点の俯瞰なら軽量で読める。
  // 現在地の色はGPS精度で変える(カシミール3D方式: 良→悪 黄/橙/赤、途絶は灰)
  function panelMap() {
    var r = S.route, pts = r.pts;
    var lat0 = pts[0][0], klon = Math.cos(lat0 * Math.PI / 180) * 111320, klat = 110540;
    var xs = [], ys = [], i;
    for (i = 0; i < pts.length; i++) { xs.push(pts[i][1] * klon); ys.push(pts[i][0] * klat); }
    var fx = null, fy = null, devd = S.dev ? S.dev.state.dist : 1e9;
    if (S.lastFix && devd < 2500) { fx = S.lastFix.lo * klon; fy = S.lastFix.la * klat; xs.push(fx); ys.push(fy); }
    var minx = Math.min.apply(0, xs), maxx = Math.max.apply(0, xs);
    var miny = Math.min.apply(0, ys), maxy = Math.max.apply(0, ys);
    var W = 460, H = 330, pad = 22;
    var sc = Math.min((W - 2 * pad) / Math.max(maxx - minx, 1), (H - 2 * pad) / Math.max(maxy - miny, 1));
    var ox = (W - (maxx - minx) * sc) / 2, oy = (H - (maxy - miny) * sc) / 2;
    function px(lo, la) {
      return [((lo * klon - minx) * sc + ox).toFixed(1), (H - ((la * klat - miny) * sc + oy)).toFixed(1)];
    }
    function path(arr) {
      var d = '';
      for (var j = 0; j < arr.length; j++) d += (j ? 'L' : 'M') + arr[j][0] + ' ' + arr[j][1];
      return d;
    }
    // 通過済み/残りで色分け
    var splitIdx = 0;
    while (splitIdx + 1 < r.cum.length && r.cum[splitIdx + 1] < S.along) splitIdx++;
    var pj = CORE.routePointAt(r, S.along);
    var done = [], todo = [[px(pj.lo, pj.la)[0], px(pj.lo, pj.la)[1]]];
    for (i = 0; i <= splitIdx; i++) done.push(px(pts[i][1], pts[i][0]));
    done.push(px(pj.lo, pj.la));
    for (i = splitIdx + 1; i < pts.length; i++) todo.push(px(pts[i][1], pts[i][0]));
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">';
    svg += '<path d="' + path(todo) + '" fill="none" stroke="#ffd83b" stroke-width="4" stroke-linejoin="round"/>';
    if (done.length > 1) svg += '<path d="' + path(done) + '" fill="none" stroke="#6b675c" stroke-width="4" stroke-linejoin="round"/>';
    for (i = 0; i < r.wps.length; i++) {
      var w2 = r.wps[i], wp2 = CORE.routePointAt(r, w2.d), q = px(wp2.lo, wp2.la);
      var passed = !!S.wpPassed[w2.d];
      svg += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="6" fill="' + (passed ? '#6b675c' : '#f5f1e6') + '"/>';
    }
    var gA2 = ghostAlongNow();
    if (gA2 != null) {
      var gp = CORE.routePointAt(r, gA2), gq2 = px(gp.lo, gp.la);
      svg += '<circle cx="' + gq2[0] + '" cy="' + gq2[1] + '" r="7" fill="none" stroke="#6b675c" stroke-width="3"/>';
    }
    if (fx != null) {
      var acc = S.lastFix.acc || 99, age = (Date.now() - S.lastFixReal) / 1000;
      var col = age > 30 ? '#6b675c' : (acc <= 25 ? '#ffd83b' : (acc <= 60 ? '#f5a11c' : '#ff5a60'));
      var pq = px(S.lastFix.lo, S.lastFix.la);
      svg += '<circle cx="' + pq[0] + '" cy="' + pq[1] + '" r="9" fill="none" stroke="' + col + '" stroke-width="3"/>';
      svg += '<circle cx="' + pq[0] + '" cy="' + pq[1] + '" r="4" fill="' + col + '"/>';
      if (S.headingSettled && S.heading != null && (Date.now() - S.headingReal) < 3000) {
        var hr = (S.heading - 90) * Math.PI / 180;   // 画面は北上固定
        svg += '<line x1="' + pq[0] + '" y1="' + pq[1] + '" x2="' + (+pq[0] + 18 * Math.cos(hr)).toFixed(1) +
               '" y2="' + (+pq[1] + 18 * Math.sin(hr)).toFixed(1) + '" stroke="' + col + '" stroke-width="3"/>';
      }
    }
    // スケールバーとN
    var bar = 100; while (bar * sc < 60) bar *= 2; while (bar * sc > 160) bar /= 2;
    svg += '<line x1="' + pad + '" y1="' + (H - 10) + '" x2="' + (pad + bar * sc).toFixed(0) + '" y2="' + (H - 10) + '" stroke="#6b675c" stroke-width="3"/>';
    svg += '<text x="' + pad + '" y="' + (H - 16) + '" fill="#6b675c" font-size="16" font-family="inherit">' + (bar >= 1000 ? (bar / 1000) + 'km' : bar + 'm') + '</text>';
    svg += '<text x="' + (W - 34) + '" y="24" fill="#6b675c" font-size="18" font-family="inherit">N↑</text>';
    svg += '</svg>';
    var cap;
    if (devd >= 2500) cap = 'ルート範囲外 (現在地は図の外)';
    else if (offRouteNow()) cap = '<span class="acc2">ルート外</span> ・ ルートまで ' + CORE.fmtKm(devd);
    else cap = '残 ' + CORE.fmtKm(Math.max(0, r.total - S.along)) + (S.lastFix && S.lastFix.acc != null ? '　±' + Math.round(S.lastFix.acc) + 'm' : '');
    var rawCap = S.lastFix
      ? S.lastFix.la.toFixed(5) + ', ' + S.lastFix.lo.toFixed(5) + ' (' + Math.round((Date.now() - S.lastFixReal) / 1000) + '秒前)'
      : '測位待ち';
    // 地形レイヤ(N2): キャッシュ済みなら下敷きに。失敗・未取得は線図のまま(仕様の縮退)
    var tKey = r.id + ':' + (r.rotatedFrom || 0) + ':' + Math.round(minx) + ':' + Math.round(miny) + ':' + sc.toFixed(4);
    var geoM = { minLo: (minx) / klon, maxLo: maxx / klon, minLa: miny / klat, maxLa: maxy / klat,
                 px: function (lo, la) { return px(lo, la); } };
    if (!terrCache[tKey]) buildTerrain(tKey, geoM, W, H);
    var terr = terrCache[tKey];
    var under = (terr && terr.url)
      ? '<img src="' + terr.url + '" width="' + W + '" height="' + H + '" style="position:absolute;left:0;top:0">'
      : '';
    var credit = (terr && terr.url) ? '地図: 地理院タイル' : '線図(地形未取得)';
    return '<div class="abs ctr" style="top:44px"><div style="position:relative;width:' + W + 'px;height:' + H + 'px;display:inline-block">' + under +
      '<div style="position:absolute;left:0;top:0">' + svg + '</div>' +
      '<div style="position:absolute;right:4px;bottom:2px;font-size:14px;color:#6b675c">' + credit + '</div></div></div>' +
      '<div class="abs ctr" style="top:396px"><span class="ct1 dim">' + cap + '</span></div>' +
      '<div class="abs ctr" style="top:428px"><span class="sub dim">' + rawCap + '</span></div>';
  }

  function panelWx() {
    if (!S.wx) return '<div class="abs ctr" style="top:200px"><span class="eta1 dim">天気データなし</span>' +
      '<div class="sub dim" style="margin-top:16px">登山口(オンライン時)に自動取得</div></div>';
    var ageH = Math.round((Date.now() - S.wx.t) / 3600000);
    var rows = '', shown = 0;
    for (var i = 0; i < S.wx.rows.length; i++) {
      var r = S.wx.rows[i];
      if (r.t != null && r.t < Date.now() - 45 * 60000) continue;  // 過ぎた時間帯は出さない
      var ppc = r.pp >= 50 ? 'acc2' : '';
      rows += '<div class="stat-row">' + r.h + '時　' + r.temp + '°　<span class="' + ppc + '">' + r.pp + '%</span></div>';
      shown++;
    }
    if (!shown) rows = '<div class="stat-row dim">予報が古いです(再取得待ち)</div>';
    return '<div class="abs ctr" style="top:100px"><span class="sub dim">登山口の予報(時刻/気温/降水)</span></div>' +
      '<div class="abs" style="top:150px;padding:0 150px">' + rows + '</div>' +
      '<div class="abs ctr" style="top:460px"><span class="sub ' + (ageH >= 6 ? 'acc2' : 'dim') + '">' + ageH + '時間前 取得</span></div>';
  }
  function scrWarn() {
    var d = S.dev ? S.dev.state.dist : 0;
    var far = d > 2000;                                  // ルートから遠い=自宅等でのテストや範囲外
    var dTxt = far ? CORE.fmtKm(d) : (Math.round(d) + '<span style="font-size:44px">m</span>');
    return '<div class="abs ctr ' + (far ? '' : 'warn-line') + '" style="top:56px">' +
      '<div class="warn-title' + (far ? ' acc2" style="color:#f5a11c' : '') + '">' +
      (far ? 'ルート範囲外' : 'ルート逸脱') + '</div>' +
      '<div class="warn-dist' + (far ? '" style="color:#f5a11c' : '') + '">' + dTxt + '</div></div>' +
      (far ? '<div class="abs ctr" style="top:250px"><span class="sub dim">矢印はルート方向(直線)</span></div>' : '') +
      '<div class="abs z-arrow ctr" style="top:270px"><div class="arrow-wrap acc2" id="arw-wrap">' + arrowSvg('arw') + '</div>' +
      '<div class="arrow-lbl dim" id="arw-na" style="display:none">方位取得不可</div>' +
      '<div class="arrow-lbl acc2">復帰方向</div></div>' +
      '<div class="abs ctr" style="bottom:24px"><span class="hint dim">ピンチ: 5分抑制　／　戻る: 閉じる</span></div>';
  }
  function scrDone() {
    var f = S.finished || {};
    return '<div class="abs ctr" style="top:50px"><span class="screen-title acc2">下山サマリー</span></div>' +
      '<div class="abs" style="top:130px;padding:0 120px"><div class="frame">' +
      '<div class="stat-row">距離　　 ' + CORE.fmtKm(f.dist || 0) + '</div>' +
      '<div class="stat-row">所要　　 ' + CORE.fmtDur(f.elapsed || 0) + '</div>' +
      '<div class="stat-row">行動　　 ' + CORE.fmtDur(f.moving || 0) + '</div>' +
      '<div class="stat-row">休憩　　 ' + CORE.fmtDur(f.stop || 0) + '</div>' +
      '<div class="stat-row">標準CT比 ' + (f.ctRatio ? f.ctRatio.toFixed(2) : '--') + '</div>' +
      (f.laps && f.laps.length ? '<div class="stat-row">Lap ' + f.laps.length + '回</div>' : '') +
      (f.summits && f.summits.length ? '<div class="stat-row acc2">登頂 ' + esc(f.summits.join('・')) + ' (通算' + f.peakTotal + '座)</div>' : '') +
      (f.ghostDiff != null ? '<div class="stat-row">' + (f.ghostLbl || 'ゴースト') + '比 ' + CORE.fmtDiff(f.ghostDiff) + '</div>' : '') +
      '</div></div>' +
      '<div class="abs ctr" style="bottom:30px"><span class="hint main-c">ピンチ/戻る で終了</span></div>';
  }

  function render() {
    if (!app) app = document.getElementById('app');
    var html = '';
    if (S.mode === 'disclaimer') html = scrDisclaimer();
    else if (S.mode === 'resume') html = scrResume();
    else if (S.mode === 'select') html = scrSelect();
    else if (S.mode === 'ready')  html = scrReady();
    else if (S.mode === 'main')   html = scrMain();
    else if (S.mode === 'ident')  html = (S.identLayer === 'sky') ? scrIdentSky() : scrIdentGround();
    else if (S.mode === 'cere')   html = scrCeremony();
    else if (S.mode === 'warn')   html = scrWarn();
    else if (S.mode === 'done')   html = scrDone();
    app.innerHTML = html;
    updateArrow();
  }

  /* ================= 起動 ================= */
  function boot() {
    applyTheme();
    // 注意: ここで initHistory() を呼んではならない。
    // 権限解決前の履歴変更(replaceState含む)は requestPermission を
    // 永久pendingにする(公式の既知問題・実機で再現确认済み)。
    if ('serviceWorker' in navigator) {                   // オフライン起動(圏外で再起動しても動く)
      try { navigator.serviceWorker.register('sw.js')['catch'](function () {}); } catch (e) {}
    }
    S.mode = 'disclaimer';
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // テスト用フック(実機では未使用)
  if (typeof window !== 'undefined') window.__THUD = { S: S, Geo: Geo, render: render, nowMs: nowMs, checkLapAndSegs: checkLapAndSegs, ghostAlongNow: ghostAlongNow };
})();
