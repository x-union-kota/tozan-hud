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
    tbMargin: (lsGet('thud.tbMargin') || 60),   // C-1: 引き返しマージン(分)
    ceremonyDone: {}, summitLog: [],
    home: lsGet('thud.home'),
    tracking: false,
    startMs: 0, movingMin: 0, stopMin: 0,
    lastFix: null, lastFixReal: 0, lastGoodFixReal: 0,
    cursor: null, along: 0, maxAlong: 0, proj: null,
    emaKmh: 0, moving: true, lastMoveMs: 0,
    dev: null, suppressUntil: 0, graceUntil: 0,
    heading: null, headingReal: 0, headingSettled: false, hmode: (lsGet('thud.hmode') || 'alpha'),
    pitch: null, pitchReal: 0,   // 仰角(0=水平, +=見上げ)。空レイヤの高度帯がこれに追従する
    posHist: [], identLock: null,   // C-4: 直近の生GPS / C-6: 注視ロック中の対象
    alongHist: [],                  // C-8: [ms, along] 直近70秒(実効速度=Δalong/Δt)
    freeSel: false, freeGoal: 0, freeLastGood: null, freeDone: false,   // その場モード
    sun: null, sunNotice: false,
    wx: null, wxTriedMs: 0,
    track: [], lastTrackMs: 0,
    wpPassed: {}, wpFlashUntil: 0, wpFlashMsg: '',
    permDenied: false,
    finished: null,
    resumeData: null
  };
  var BUILT = ROUTES.map(CORE.buildRoute);
  // その場モード用の内蔵レジストリ。峰は tools/gpx2route.py の FAMOUS と同一内容
  // (gpx2route.test.py が両者の一致を検査する)。塔は make_registry.py の東京目印から
  var FAMOUS = [
    ['富士山',35.3606,138.7274,3776],['北岳',35.6745,138.2389,3193],['奥穂高岳',36.2894,137.6480,3190],
    ['槍ヶ岳',36.3420,137.6476,3180],['御嶽山',35.8930,137.4800,3067],['乗鞍岳',36.1060,137.5540,3026],
    ['立山',36.5730,137.6180,3015],['白馬岳',36.7580,137.7580,2932],['甲斐駒ヶ岳',35.7580,138.2370,2967],
    ['仙丈ヶ岳',35.7200,138.1830,3033],['八ヶ岳(赤岳)',35.9706,138.3703,2899],['浅間山',36.4060,138.5230,2568],
    ['金峰山',35.8720,138.6280,2599],['雲取山',35.8556,138.9439,2017],['男体山',36.7650,139.4910,2486],
    ['谷川岳',36.8340,138.9300,1977],['赤城山',36.5600,139.1930,1828],['筑波山',36.2250,140.1060,877],
    ['丹沢山',35.4750,139.1620,1567],['大山(丹沢)',35.4400,139.2320,1252],['高尾山',35.6252,139.2436,599],
    ['大岳山',35.7610,139.1220,1266],['御岳山(奥多摩)',35.7830,139.1490,929],['箱根山(神山)',35.2330,139.0210,1438],
    ['天城山',34.8640,139.0060,1406],['大台ヶ原山',34.1860,136.1080,1695],['大峰山(八経ヶ岳)',34.1680,135.9070,1915],
    ['石鎚山',33.7670,133.1150,1982],['剣山',33.8530,134.0940,1955],['阿蘇山(高岳)',32.8840,131.1040,1592],
    ['九重山(中岳)',33.0860,131.2490,1791],['桜島(御岳)',31.5850,130.6570,1117],['開聞岳',31.1800,130.5280,924],
    ['大山(伯耆)',35.3710,133.5460,1729],['岩木山',40.6560,140.3030,1625],['岩手山',39.8530,141.0010,2038],
    ['鳥海山',39.0990,140.0490,2236],['月山',38.5490,140.0270,1984],['磐梯山',37.6010,140.0720,1816],
    ['那須岳(茶臼岳)',37.1250,139.9630,1915],['妙高山',36.8910,138.1130,2454],['白山',36.1550,136.7710,2702]
  ];
  var LANDMARKS = [
    ['東京スカイツリー',35.7101,139.8107,634],['東京タワー',35.6586,139.7454,333],
    ['都庁',35.6896,139.6917,243],['レインボーブリッジ',35.6365,139.7630,126]
  ];
  function freeReg(la, lo) {                        // 現在地150km圏の峰 + 60km圏の塔。全部「透視」
    var reg = [], i, d;
    for (i = 0; i < FAMOUS.length; i++) {
      d = CORE.hav([la, lo], [FAMOUS[i][1], FAMOUS[i][2]]);
      if (d <= 150000) reg.push({ n: FAMOUS[i][0], la: FAMOUS[i][1], lo: FAMOUS[i][2], el: FAMOUS[i][3], t: 'peak', v: 0 });
    }
    for (i = 0; i < LANDMARKS.length; i++) {
      d = CORE.hav([la, lo], [LANDMARKS[i][1], LANDMARKS[i][2]]);
      if (d <= 60000) reg.push({ n: LANDMARKS[i][0], la: LANDMARKS[i][1], lo: LANDMARKS[i][2], el: LANDMARKS[i][3], t: 'tower', v: 0 });
    }
    return reg;
  }
  function buildFreeRoute(la, lo, goalM) {          // 1点だけのルート。along は「走った距離」として使う
    return { id: 'free', name: 'ここから' + (goalM ? ' ' + (goalM / 1000) + 'km' : ''), demo: false, free: true,
             pts: [[la, lo, 0]], cum: [0], gcum: [0], total: goalM || 0, gainTotal: 0,
             wps: [], cts: null, ctTotal: null, reg: freeReg(la, lo), dec: CORE.decJapan(la, lo),
             domain: 'free', segs: [], vec: null };
  }
  function isFree() { return !!(S.route && S.route.free); }

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
      var p, ah2;
      if (S.route.free) {                               // その場モード: 起点から北東へ直進
        var q0 = CORE.destPoint(S.route.pts[0][0], S.route.pts[0][1], 45, sim.along);
        var q1 = CORE.destPoint(S.route.pts[0][0], S.route.pts[0][1], 45, sim.along + 40);
        p = { la: q0[0], lo: q0[1] }; ah2 = { la: q1[0], lo: q1[1] };
      } else {
        p = CORE.routePointAt(S.route, sim.along);
        ah2 = CORE.routePointAt(S.route, Math.min(S.route.total, sim.along + 40));
      }
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
      S.heading = (CORE.bearing([p.la, p.lo], [ah2.la, ah2.lo]) + (sim.headOff || 0) + gauss() * 8 + 360) % 360;
      S.headingReal = Date.now(); S.headingSettled = true;
      S.pitch = sim.pitchOff || 0; S.pitchReal = Date.now();   // simの仰角(y/uキーで動かす)
      scheduleArrow();
      cb({ la: pos[0], lo: pos[1], acc: acc, t: nowMs() });
    }

    return {
      sim: sim,
      start: function (cb, errCb) {
        if (SIM) {
          sim.running = true;
          sim.mps = S.route.free ? 2.5                              // その場モード: 約6:40/km
                                 : S.route.total / (S.route.ctTotal * 60) * 1.05; // CTよりやや速く
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
      if (e.beta != null) {
        DIAG.beta = e.beta;
        // 仰角: 端末を立てた姿勢が beta≈90 なので 90 を引いて「水平=0・見上げ=+」にする。
        // ★実機で1度だけ確認が要る(HANDOFF §4-8)。診断画面の β と ピッチ を見て、
        //   水平を向いたときピッチが0付近ならこの仮定で合っている
        var pr = Math.max(-85, Math.min(85, e.beta - 90));
        S.pitch = (S.pitch == null) ? pr : (0.3 * pr + 0.7 * S.pitch);
        S.pitchReal = Date.now();
      }
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
    if (SIM) {                  // simには現在地が無いので、その場モードは東京駅を現在地にする
      if (S.freeSel && !S.readyGeo) S.readyGeo = { la: 35.6812, lo: 139.7671, acc: 10 };
      return;
    }
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
    if ((from === 'ident' || from === 'cere' || from === 'detail') && target === 'main') {
      setNight(false); S.identLock = null; S.mode = 'main'; render(); return;
    }
    if (target === 'detail') { setNight(false); S.identLock = null; S.mode = 'detail'; render(); return; }  // 透視→詳細へ戻る
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
    if (S.freeSel) {                                   // その場モードは現在地が無いと何も決まらない
      S.perm = 'その場モードは現在地が必要です。GPSが取れる場所でもう一度ピンチ'; render(); return;
    }
    clearStartWatchdog();
    S.starting = false; S.startFailed = false; S.perm = '';
    startTracking(null, restore);
  }

  function startTracking(firstFix, restore) {
    if (S.freeSel) {
      var f0 = firstFix || S.readyGeo || DIAG.raw;
      if (!f0) { S.perm = 'その場モードは現在地が必要です'; S.starting = false; render(); return; }
      S.route = buildFreeRoute(f0.la, f0.lo, S.freeGoal);
      S.sun = CORE.sunTimes(f0.la, f0.lo, nowDate());
    }
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
      var lastTk = isFree() ? null : lsGet('thud.lastTrack.' + S.route.id);
      if (lastTk && lastTk.length > 8) { S.ghost = { samples: lastTk }; S.ghostSrc = 'last'; }
      else { S.ghost = null; S.ghostSrc = isFree() ? '' : 'ct'; }   // free は目標ペース以外のゴースト無し
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

  function onFixFree(f, prev) {
    // ルートが無いので「沿道距離」=「動いた距離の積算」。ノイズは足さない。
    // 基準は「最後に採用した良い測位」。低精度の測位で基準をずらすと次の距離が嘘になる
    if (f.acc != null && f.acc > 50) return;
    var base = S.freeLastGood;
    if (base) {
      var d = CORE.hav([base.la, base.lo], [f.la, f.lo]);
      if (d >= 3 && d < 500) { S.along += d; S.maxAlong = S.along; S.lastMoveMs = nowMs(); S.freeLastGood = f; }
      else if (d >= 500) S.freeLastGood = f;             // 瞬間移動は足さないが基準は進める
    } else { S.lastMoveMs = nowMs(); S.freeLastGood = f; }
    S.proj = { dist: 0, along: S.along, seg: 0 }; S.cursor = 0;
    S.alongHist.push([Date.now(), S.along]);
    while (S.alongHist.length && Date.now() - S.alongHist[0][0] > 70000) S.alongHist.shift();
    S.lastGoodFixReal = Date.now();
    if (S.route.total && S.along >= S.route.total && !S.freeDone) {
      S.freeDone = true; wpFlash('目標 ' + (S.route.total / 1000) + 'km 到達');
    }
    scheduleArrow(); render();
  }
  function onFix(f) {
    var prev = S.lastFix;
    S.lastFix = f; S.lastFixReal = Date.now();
    S.posHist.push([Date.now(), f.la, f.lo, f.acc]);          // C-4: 実進行ベクトル用
    while (S.posHist.length && Date.now() - S.posHist[0][0] > 20000) S.posHist.shift();
    if (isFree()) { onFixFree(f, prev); return; }
    if (f.acc != null && f.acc > 75) { return; }         // 低精度は生存確認のみ(F2/判定不使用)
    var m = CORE.matchLocal(S.route, S.cursor, f.la, f.lo, S.along); // 初回もalong=0起点でバイアス(ピストンの往復同一線形対策)
    if (!m) return;
    S.lastGoodFixReal = Date.now();
    S.cursor = m.seg; S.proj = m;
    S.along = m.along;
    S.alongHist.push([Date.now(), m.along]);                 // C-8: 実効速度用
    while (S.alongHist.length && Date.now() - S.alongHist[0][0] > 70000) S.alongHist.shift();
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
    // サマリーのゴースト比も同じ式(ラベルのソースと一致させる)
    var gdl = (S.ghostSrc && !isLoopRoute()) ? CORE.ghostDelta(S.ghostSrc, S.maxAlong, elapsed * 60,
      { route: S.route, paceGoal: S.paceGoal, samples: (S.ghost && S.ghost.samples) || null }) : null;
    if (gdl != null) {
      S.finished.ghostDiff = -gdl / 60;
      S.finished.ghostLbl = { ct: '標準CT', last: '前回の自分', pace: '目標ペース' }[S.ghostSrc] || 'ゴースト';
    } else {
      var gd = CORE.ctAt(S.route, S.maxAlong);
      S.finished.ghostDiff = (gd && gd > 10) ? (S.movingMin - gd) : null;
      S.finished.ghostLbl = '標準CT';
    }
    if (S.track.length > 8 && !isFree()) {
      lsSet('thud.lastTrack.' + S.route.id, S.track.map(function (s) { return [s[0], s[3] || 0]; }));
    }
    S.finished.free = isFree();
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
    // 計測中はモードに関係なく進める。以前は main/warn 以外で止めていたため、
    // 透視や星を開いている間はトラック記録・ラップ判定・キープアライブ測位・再描画が
    // 全部止まっていた(実機で「顔を動かしても変わらない」と出た原因の半分)
    if (!S.tracking) return;
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
    if (!isFree()) checkLapAndSegs(t);
    // 日没90分前通知(1回)
    if (S.sun && S.sun.sunset && !S.sunNotice) {
      var remMin = (S.sun.sunset.getTime() - t) / 60000;
      if (remMin > 0 && remMin <= 90) { S.sunNotice = true; wpFlash('日没90分前 ヘッデン準備'); }
    }
    if (!isFree()) evalWarn();
    render();
  }

  function saveActive() {
    if (isFree()) return;                              // その場モードは再開対象にしない(ルートが無い)
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
    if (SIM && handleSimKey(k)) { e.preventDefault(); render(); return; }   // 方位/仰角キーは即座に反映する
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
      if (k === 'ArrowLeft')  { S.routeIdx = (S.routeIdx + NSEL() - 1) % NSEL(); render(); }
      if (k === 'ArrowRight') { S.routeIdx = (S.routeIdx + 1) % NSEL(); render(); }
      if (k === 'Enter') { toReady(); }
      return;
    }
    if (S.mode === 'ready' && S.freeSel && !S.diag) {
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        var gs = [0, 5000, 10000], gi = Math.max(0, gs.indexOf(S.freeGoal));
        S.freeGoal = gs[(gi + (k === 'ArrowRight' ? 1 : 2)) % 3]; render(); return;
      }
      if (k === 'ArrowUp') return;                          // 目標ペースはルート無しでは組めない(段階2)
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
      if (k === 'ArrowDown')  { pushScreen('detail'); S.mode = 'detail'; render(); }   // C-7/C-8 の詳細ページ
      if (k === 'Enter' && S.panel === 3) manualWp();   // WP確認は次WPパネル表示中のみ
      if (k === 'Escape') goBack();                       // → 終了(popstateでdoneへ)
      return;
    }
    if (S.mode === 'detail') {
      if (k === 'ArrowLeft' || k === 'ArrowRight') {            // C-1 の引き返しマージン 30/60/90
        var opts = [30, 60, 90], ci = Math.max(0, opts.indexOf(S.tbMargin));
        S.tbMargin = opts[(ci + (k === 'ArrowRight' ? 1 : 2)) % 3];
        lsSet('thud.tbMargin', S.tbMargin); render(); return;
      }
      if (k === 'Enter') { S.theme = (S.theme === 'w') ? 'y' : 'w'; applyTheme(); render(); return; }
      if (k === 'ArrowUp') { enterIdent(); return; }
      if (k === 'ArrowDown' || k === 'Escape') { goBack(); return; }
      return;
    }
    if (S.mode === 'ident') {
      if (k === 'Enter' && S.identLayer === 'ground') {        // C-6: 中央±8°の対象をロック
        var ht2 = headingTrue();
        if (ht2 != null && S.headingSettled) {
          var its = identItems() || [], best = null;
          for (var ii = 0; ii < its.length; ii++) {
            var dd2 = Math.abs(CORE.angDiff(its[ii].brg, ht2));
            if (dd2 <= 8 && (!best || dd2 < best.d)) best = { d: dd2, it: its[ii] };
          }
          if (best) {
            S.identLock = { n: best.it.n, brg: best.it.brg, dist: best.it.dist,
                            el: best.it.el, vis: best.it.vis };
            wpFlash(best.it.n + ' をロック');
          } else wpFlash('中央±8°に対象がありません');
        }
        render(); return;
      }
      if (k === 'Escape' && S.identLock) { S.identLock = null; render(); return; }  // まず解除
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        S.identLayer = (S.identLayer === 'ground') ? 'sky' : 'ground';
        setNight(S.identLayer === 'sky' && S.sun && S.sun.sunset && nowMs() > S.sun.sunset.getTime());
        render(); return;
      }
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && S.identLayer === 'ground') {
        S.identFilter = (S.identFilter + (k === 'ArrowRight' ? 1 : 2)) % 3; render(); return;
      }
      if (k === 'Escape') { setNight(false); S.identLock = null; goBack(); }
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
    // 首振り(j/k)と仰角(y/u)。次のfixを待たずS側にも即反映する(でないと最大1秒遅れる)
    if (k === 'j' || k === 'J' || k === 'k' || k === 'K') {
      var dh = (k === 'k' || k === 'K') ? 15 : -15;
      sim.headOff = (sim.headOff || 0) + dh;
      if (S.heading != null) { S.heading = ((S.heading + dh) % 360 + 360) % 360; S.headingReal = Date.now(); }
      return true;
    }
    if (k === 'y' || k === 'Y' || k === 'u' || k === 'U') {
      var dp = (k === 'u' || k === 'U') ? 10 : -10;
      sim.pitchOff = Math.max(-60, Math.min(80, (sim.pitchOff || 0) + dp));
      S.pitch = sim.pitchOff; S.pitchReal = Date.now();
      return true;
    }
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
    S.freeSel = (S.routeIdx === BUILT.length);
    if (S.freeSel) {                                   // その場モード: 現在地が要るので先に測る
      S.route = null; S.sun = null; S.freeDone = false;
      S.startCands = null; S.startIdx = 0; S.startManual = false; S.startSuggested = false; S.readyGeo = null;
      S.paceGoal = null; S.paceEdit = null;
      readyGeoPoll();
      pushScreen('ready'); S.mode = 'ready'; startTicker(); render();
      return;
    }
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
      '</g>' +
      // C-4: 実際の移動方向。矢印(ルート先)と重なっていれば安心、離れ始めたら予兆
      '<g id="' + id + '-t" transform="rotate(0 50 50)" style="display:none">' +
      '<polygon points="50,0 46,9 54,9" fill="#f5f1e6"/></g>' +
      '</svg>';
  }
  var arrowPending = false;
  var viewLastMs = 0;
  function scheduleArrow() {
    if (arrowPending) return; arrowPending = true;
    requestAnimationFrame(function () {
      arrowPending = false;
      updateArrow();                                   // 矢印は毎フレーム(軽い)
      // 方位で決まる表示(テープ・透視・星)はイベントごとに描き直す。
      // 1Hzのtick任せだとカクカクになる(実機で確認)。全体の innerHTML 差し替えは
      // 重いので 50ms(≈20fps)に間引き、main ではテープだけを差し替える
      var now = Date.now();
      if (now - viewLastMs < 50) { arrowPending = true; requestAnimationFrame(function () { arrowPending = false; refreshHeadingView(); }); return; }
      refreshHeadingView();
    });
  }
  function refreshHeadingView() {
    viewLastMs = Date.now();
    if (S.mode === 'ident') { render(); return; }
    if (S.mode === 'main') {
      var tp = document.getElementById('tape');
      if (tp) tp.outerHTML = headingTape();
    }
  }
  function arrowTarget() {
    if (!S.proj || isFree()) return null;
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
    var tg = document.getElementById('arw-t');
    if (tg) {
      var tb = travelBearing();
      if (tb == null) tg.style.display = 'none';
      else {
        tg.style.display = 'block';
        tg.setAttribute('transform', 'rotate(' + (((tb - S.heading) % 360 + 360) % 360).toFixed(0) + ' 50 50)');
      }
    }
  }

  /* ---- C-4: 実進行ベクトル ---- */
  function travelBearing() {
    var h = S.posHist;
    if (!h.length) return null;
    var now = Date.now(), oldest = null;
    for (var i = 0; i < h.length; i++) { if (now - h[i][0] <= 15000) { oldest = h[i]; break; } }
    var newest = h[h.length - 1];
    if (!oldest || oldest === newest) return null;
    if (newest[3] != null && newest[3] > 50) return null;      // 精度不足なら出さない
    var dt = (newest[0] - oldest[0]) / 1000;
    var d = CORE.hav([oldest[1], oldest[2]], [newest[1], newest[2]]);
    if (dt <= 0 || d < 10 || d / dt < 0.5) return null;         // 停止・微動は出さない
    return CORE.bearing([oldest[1], oldest[2]], [newest[1], newest[2]]);
  }
  /* ---- C-9: コース偏差バー(数字は出さない) ---- */
  function crossTrackHtml() {
    if (!S.proj || !S.lastFix) return '';
    if (S.dev && S.dev.state.deviated) return '';               // ルート外は既存フローに任せる
    var x = CORE.signedCrossTrack(S.route, S.along, S.lastFix.la, S.lastFix.lo);
    if (x == null || Math.abs(x) > 50) return '';
    var W = 180, px = 300 + Math.max(-1, Math.min(1, x / 50)) * (W / 2);
    return '<svg viewBox="0 0 600 14" width="600" height="14">' +
      '<line x1="' + (300 - W / 2) + '" y1="7" x2="' + (300 + W / 2) + '" y2="7" stroke="#6b675c" stroke-width="2"/>' +
      '<line x1="300" y1="2" x2="300" y2="12" stroke="#6b675c" stroke-width="2"/>' +
      '<circle cx="' + px.toFixed(0) + '" cy="7" r="5" fill="#ffd83b"/></svg>';
  }

  /* ---- C-5: 方位テープ(メイン常設) ----
     透視モードは「このテープを±30°に拡大して対象名を乗せたもの」という位置づけ。
     見た目を連続させるため、目盛の描き方は同じにしてある。 */
  function tapeMarkers(ht) {
    var out = [];
    if (!S.lastFix || !S.route) return out;
    var me = [S.lastFix.la, S.lastFix.lo];
    var w = nextWp();
    if (w) {
      var wp = CORE.routePointAt(S.route, w.d);
      out.push({ n: w.n, brg: CORE.bearing(me, [wp.la, wp.lo]), c: '#ffd83b' });
    }
    var gp = CORE.routePointAt(S.route, S.route.total);
    out.push({ n: isFree() ? '起点' : 'ゴール', brg: CORE.bearing(me, [gp.la, gp.lo]), c: '#f5f1e6' });
    if (S.sun && S.sun.sunset) {
      var ss = ASTRO.sunAltAz(me[0], me[1], S.sun.sunset.getTime());
      out.push({ n: '日没', brg: ss.az, c: '#f5a11c' });
    }
    var gA = ghostAlongNow();
    if (gA != null) {
      var g = CORE.routePointAt(S.route, gA);
      out.push({ n: 'G', brg: CORE.bearing(me, [g.la, g.lo]), c: '#6b675c' });
    }
    if (S.home) out.push({ n: '家', brg: CORE.bearing(me, [S.home.la, S.home.lo]), c: '#6b675c' });
    return out;
  }
  function headingTape() {
    var H = 50, HALF = 45, W = 600;
    var ht = headingTrue();
    if (ht == null || !S.headingSettled) {
      return '<div id="tape" class="abs" style="top:0;height:' + H + 'px"><div class="ctr" style="padding-top:14px">' +
        '<span class="sub dim">方位' + (S.heading == null ? '取得待ち' : '較正中') + '…</span></div></div>';
    }
    var svg = '<svg viewBox="0 0 600 ' + H + '" width="600" height="' + H + '">';
    for (var t = -HALF; t <= HALF; t += 15) {          // 15°刻みの目盛
      var x = (300 + t * (W / 2 - 20) / HALF).toFixed(0);
      var lbl = Math.round(((ht + t) % 360 + 360) % 360);
      var mid = (t === 0);
      svg += '<line x1="' + x + '" y1="30" x2="' + x + '" y2="' + (mid ? 44 : 40) +
        '" stroke="' + (mid ? '#ffd83b' : '#6b675c') + '" stroke-width="' + (mid ? 3 : 2) + '"/>';
      svg += '<text x="' + x + '" y="' + H + '" fill="' + (mid ? '#ffd83b' : '#6b675c') +
        '" font-size="' + (mid ? 21 : 18) + '" text-anchor="middle" font-family="inherit">' + lbl + '°</text>';
    }
    var mk = tapeMarkers(ht);
    for (var i = 0; i < mk.length; i++) {
      var d = CORE.angDiff(mk[i].brg, ht);
      if (Math.abs(d) > HALF) continue;
      var mx = (300 + d * (W / 2 - 20) / HALF).toFixed(0);
      svg += '<polygon points="' + mx + ',28 ' + (+mx - 5) + ',18 ' + (+mx + 5) + ',18" fill="' + mk[i].c + '"/>';
      svg += '<text x="' + mx + '" y="16" fill="' + mk[i].c + '" font-size="18" text-anchor="middle" font-family="inherit">' + esc(mk[i].n) + '</text>';
    }
    svg += '</svg>';
    return '<div id="tape" class="abs" style="top:0;height:' + H + 'px;line-height:0">' + svg + '</div>';
  }

  /* ---- C-7/C-8: ↓詳細ページ(勾配ラダー・次の登り・実効速度・設定) ---- */
  function climbAhead() {
    if (!S.proj || !S.route || S.route.domain === 'urban' || isFree()) return null;
    if (staleInfo().sec > 600) return null;
    return CORE.nextClimb(S.route, S.along, 8, 100);
  }
  function vmgNow() {
    if (!S.proj || staleInfo().sec > 90 || offRouteNow()) return null;
    return CORE.vmg(S.alongHist, Date.now(), 60);
  }
  function vmgText() {
    var v = vmgNow();
    if (v == null || v <= 0.05) return '—';
    if (S.route.domain === 'urban') {
      var spk = 1000 / v, mm = Math.floor(spk / 60), ss = Math.round(spk % 60);
      return mm + ':' + (ss < 10 ? '0' : '') + ss + '/km';
    }
    return Math.round(v * 60) + 'm/分';
  }
  function scrDetail() {
    var urban = S.route && S.route.domain === 'urban';
    var g = (S.proj && !urban && staleInfo().sec <= 600) ? CORE.gradeAt(S.route, S.along, 50) : null;
    var gTxt = g == null ? '—' : ((g >= 0 ? '↗ ' : '↘ ') + Math.abs(Math.round(g)) + '%');
    var nc = climbAhead();
    var ncTxt = urban ? '' : (nc ? climbText(nc) : 'この先 8%超の登りなし');
    var margin = urban ? '' :
      '<div class="stat-row">引き返しマージン <span class="dim">◂ </span><span class="main-c">' + S.tbMargin + '分</span><span class="dim"> ▸</span></div>';
    return headingTape() +
      '<div class="abs ctr" style="top:70px"><span class="sub dim">詳細</span></div>' +
      '<div class="abs ctr" style="top:100px"><div class="big2 main-c">' + gTxt + '</div>' +
      '<div class="sub dim">現在勾配(直近50m)</div></div>' +
      (ncTxt ? '<div class="abs ctr" style="top:190px"><span class="ct1 ' + (nc ? 'acc2' : 'dim') + '">' + esc(ncTxt) + '</span></div>' : '') +
      '<div class="abs ctr" style="top:240px"><span class="eta1">実効 ' + vmgText() + '</span>' +
      '<div class="sub dim">沿道距離ベース・直近60秒(後戻り・停止は —)</div></div>' +
      '<div class="abs" style="top:330px;padding:0 90px"><div class="frame">' + margin +
      '<div class="stat-row">表示色 <span class="main-c">' + (S.theme === 'w' ? '白(低輝度)' : '黄(高輝度)') + '</span> <span class="dim">ピンチで切替</span></div>' +
      '</div></div>' +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">' + (urban ? '' : '←→ マージン ／ ') + '↑ 透視 ／ ↓ 戻る</span></div>';
  }
  var bandRotMs = 0;
  function climbBandText() {                        // C-7: メインでは帯ローテーションに1件(10秒周期の前半)
    var nc = climbAhead();
    if (!nc || nc.startIn > 300) return null;
    if (Math.floor(Date.now() / 5000) % 2 !== 0) return null;
    return { c: 'main-c', s: climbText(nc) };
  }
  function climbText(nc) {                          // 「0m先」は変。登り始めていたら「登り中」
    var len = Math.round(nc.len / 10) * 10 + 'm 平均' + Math.round(nc.avg) + '%';
    return nc.startIn < 50 ? '登り中 ' + len : Math.round(nc.startIn / 10) * 10 + 'm先 登り ' + len;
  }

  /* ---- C-1: 引き返し限界 ---- */
  function turnaround() {
    // 正直さゲート: 現在地未収束・日没未取得・urbanは出さない
    if (!S.proj || !S.route || S.route.domain === 'urban' || isFree()) return null;
    if (!S.sun || !S.sun.sunset) return null;
    if (staleInfo().sec > 600) return null;
    return CORE.turnaroundLimit(S.route, S.along, S.sun.sunset.getTime(), S.tbMargin, nowMs());
  }
  function turnaroundHtml() {
    var t = turnaround();
    if (!t) return '';
    var m = Math.round(t.remainMin);
    var cls = m <= 0 ? 'acc1' : (m <= 15 ? 'acc2' : 'dim');
    var body = m <= 0
      ? '引き返し限界 ' + CORE.fmtClock(new Date(t.at)) + ' <span class="acc1">超過</span>'
      : '引き返し限界 ' + CORE.fmtClock(new Date(t.at)) + ' (あと' + m + '分)';
    return '<div class="abs ctr" style="top:470px"><span class="sub ' + cls + '">' + body + '</span></div>';
  }

  /* ---- C-2: ゴーストとの時間差(デルタバー) ---- */
  var deltaHist = [];
  function ghostDeltaNow() {
    if (!S.tracking || !S.proj || !S.ghostSrc) return null;
    var st = staleInfo();
    if (st.sec > 90 || offRouteNow()) return null;      // 既存のゴースト消灯条件を継承
    var loop = isLoopRoute();
    var el = (nowMs() - (loop ? (S.lapStartMs || S.startMs) : S.startMs)) / 1000;
    return CORE.ghostDelta(S.ghostSrc, S.along, el, {
      route: S.route, paceGoal: S.paceGoal,
      samples: (S.ghost && S.ghost.samples) || null
    });
  }
  function ghostDeltaHtml() {
    var d = ghostDeltaNow();
    if (d == null) return '';
    var t = Date.now();
    deltaHist.push([t, d]);
    while (deltaHist.length && t - deltaHist[0][0] > 30000) deltaHist.shift();
    var trend = '';
    if (deltaHist.length > 3) {
      var was = Math.abs(deltaHist[0][1]), now = Math.abs(d);
      trend = now < was - 0.5 ? ' ▲' : (now > was + 0.5 ? ' ▼' : '');   // ▲=差が縮んでいる
    }
    var FULL = 60, W = 240, x = 300 + Math.max(-1, Math.min(1, d / FULL)) * (W / 2);
    var col = d >= 0 ? '#ffd83b' : '#f5a11c';
    // 60秒までは秒(0.1刻み)、それを超えたら分。1500.0s のような桁は一目で読めない
    var ad = Math.abs(d);
    var txt = (d >= 0 ? '+' : '−') +
      (ad < 60 ? ad.toFixed(1) + 's' : CORE.fmtDur(ad / 60)) + trend;
    return '<svg viewBox="0 0 600 46" width="600" height="46">' +
      '<line x1="' + (300 - W / 2) + '" y1="30" x2="' + (300 + W / 2) + '" y2="30" stroke="#6b675c" stroke-width="2"/>' +
      '<line x1="300" y1="22" x2="300" y2="38" stroke="#6b675c" stroke-width="2"/>' +
      '<rect x="' + Math.min(300, x).toFixed(0) + '" y="26" width="' + Math.abs(x - 300).toFixed(0) +
      '" height="8" fill="' + col + '"/>' +
      '<text x="300" y="16" fill="' + col + '" font-size="21" text-anchor="middle" font-family="inherit">' +
      txt + '</text></svg>';
  }

  /* ---- C-3: エッジキュー(±30°の窓の外にある対象) ---- */
  function lockHtml(ht) {
    var L = S.identLock;
    if (!L) return '';
    var d = CORE.angDiff(L.brg, ht);
    var side = d < 0 ? '←' : '→';
    return '<div class="abs ctr" style="top:352px"><span class="ct1 main-c" ' +
      'style="border:2px solid #ffd83b;border-radius:6px;padding:4px 12px">' +
      esc(L.n) + (L.el != null ? ' ' + L.el + 'm' : '') +
      (L.dist != null ? ' ' + CORE.fmtKm(L.dist) : '') +
      ' ' + side + Math.abs(Math.round(d)) + '°</span></div>';
  }
  function edgeCues(ht) {
    var items = identItems() || [], out = { l: null, r: null };
    var cand = [];
    if (S.identLock) {                                        // ロック中の対象が最優先
      var ld = CORE.angDiff(S.identLock.brg, ht);
      if (Math.abs(ld) > 30) cand.push({ n: S.identLock.n, d: ld, pri: -1, abs: Math.abs(ld) });
    }
    for (var i = 0; i < items.length; i++) {
      var d = CORE.angDiff(items[i].brg, ht);
      if (Math.abs(d) <= 30) continue;                  // 窓の中はキューにしない
      cand.push({ n: items[i].n, d: d, pri: items[i].vis && items[i].t === 'peak' ? 0 : 2,
                  abs: Math.abs(d) });
    }
    var gA = ghostAlongNow();
    if (gA != null && S.lastFix) {
      var gp = CORE.routePointAt(S.route, gA);
      var gd = CORE.angDiff(CORE.bearing([S.lastFix.la, S.lastFix.lo], [gp.la, gp.lo]), ht);
      if (Math.abs(gd) > 30) cand.push({ n: 'ゴースト', d: gd, pri: 1, abs: Math.abs(gd) });
    }
    cand.sort(function (a, b) { return a.pri - b.pri || a.abs - b.abs; });
    for (i = 0; i < cand.length; i++) {
      var side = cand[i].d < 0 ? 'l' : 'r';
      if (!out[side]) out[side] = cand[i];
    }
    return out;
  }
  function edgeCueHtml(ht) {
    var e = edgeCues(ht), h = '';
    // 方位目盛(y≈314)より下、詳細行(352)より上に置く
    if (e.l) h += '<div class="abs" style="top:322px;left:8px;text-align:left"><span class="sub dim">← ' +
      esc(e.l.n) + ' ' + Math.round(e.l.abs) + '°</span></div>';
    if (e.r) h += '<div class="abs" style="top:322px;right:8px;left:auto;text-align:right"><span class="sub dim">' +
      esc(e.r.n) + ' ' + Math.round(e.r.abs) + '° →</span></div>';
    return h;
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
    var cb = climbBandText();
    if (cb && S.mode === 'main') return cb;
    if (S.ghostBehind != null && S.mode === 'main') return { c: 'dim', s: 'ゴースト後方 ' + S.ghostBehind + 'm', ghost: true };
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
  function headingWait() {
    // 「較正中」と「取れていない」は別物。黙って手動に落とさず、どちらなのかを言う(SPEC B-3)
    if (SIM) return '<div class="eta1 dim">方位較正中…</div>';
    var got = DIAG.oriN + DIAG.absN;
    if (got === 0 && DIAG.reqMs && Date.now() - DIAG.reqMs > 5000) {
      return '<div class="eta1 acc2">方位取得不可</div>' +
        '<div class="sub dim" style="margin-top:14px">センサーイベントが1件も来ていません。' +
        '戻る→↓の診断画面で ori/abs の受信数と権限を確認してください</div>';
    }
    return '<div class="eta1 dim">方位較正中…</div>' +
      '<div class="sub dim" style="margin-top:14px">頭をゆっくり左右に振ってください</div>';
  }
  function scrIdentGround() {
    var ht = headingTrue();
    if (!S.lastFix) return identShell('<div class="abs ctr" style="top:250px"><span class="eta1 dim">GPS待ち…</span></div>');
    if (ht == null || !S.headingSettled) {
      return identShell('<div class="abs ctr" style="top:250px">' + headingWait() + '</div>');
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
      svg += '<text x="' + x + '" y="280" fill="#6b675c" font-size="18" text-anchor="middle" font-family="inherit">' + lbl + '°</text>';
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
    return identShell('<div class="abs" style="top:36px">' + svg + '</div>' +
      (S.identLock ? lockHtml(ht) : detail) + edgeCueHtml(ht) +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">←→ ' + f +
      ' ／ ↑↓ 空レイヤ ／ ' + (S.identLock ? '戻るで解除' : 'ピンチでロック') + '</span></div>');
  }
  var SKY = null;
  function sky() {   // 星表は一度だけ展開してキャッシュ(圧縮形式 → s/v/c)
    if (!SKY) SKY = CORE.buildStars(typeof STARS !== 'undefined' ? STARS : null);
    return SKY;
  }
  function scrIdentSky() {
    var ht = headingTrue();
    if (ht == null || !S.headingSettled || !S.lastFix) {
      return identShell('<div class="abs ctr" style="top:250px">' + headingWait() + '</div>');
    }
    var me = [S.lastFix.la, S.lastFix.lo], t = nowMs(), HALF = 30;
    // 仰角追従: いま見上げている角度の ±25°を映す。betaが来ないときは既定帯20〜60°
    var pitchOk = (S.pitch != null) && (Date.now() - S.pitchReal) < 3000;
    // 仰角が来ていれば「いま見上げている角度±25°」、来ていなければ既定帯20〜60°(SPEC B-5)
    var vLo = pitchOk ? S.pitch - 25 : 20;
    var vHi = pitchOk ? S.pitch + 25 : 60;
    var svg = '<svg viewBox="0 0 600 430" width="600" height="430">';
    function sy(alt) { return 400 - (alt - vLo) / (vHi - vLo) * 340; }
    if (vLo <= 0 && vHi >= 0) {                       // 地平線が帯の中にあるときだけ引く
      var hy = sy(0).toFixed(0);
      svg += '<line x1="30" y1="' + hy + '" x2="570" y2="' + hy + '" stroke="#6b675c" stroke-width="2"/>';
    }
    var K = sky(), NS = K.s.length;
    var pos = {}, i, vis = 0;
    function place(idx, ra, dec) {
      var aa = ASTRO.altAz(ra, dec, me[0], me[1], t);
      var dd = CORE.angDiff(aa.az, ht);
      if (aa.alt < vLo || aa.alt > vHi || Math.abs(dd) > HALF) return;
      pos[idx] = [stripX(dd, HALF), sy(aa.alt)];
      vis++;
    }
    for (i = 0; i < NS; i++) place(i, K.s[i][1], K.s[i][2]);
    // 線の頂点専用の星も置く。等級カット外だが、落とすと星座線が途中で切れる
    for (i = 0; i < K.v.length; i++) place(NS + i, K.v[i][0], K.v[i][1]);
    var ck; // 星座線(両端が視界内のもの)
    for (ck in K.c) {
      var lines = K.c[ck].l;
      for (i = 0; i < lines.length; i++) {
        var pA = pos[lines[i][0]], pB = pos[lines[i][1]];
        if (pA && pB) svg += '<line x1="' + pA[0].toFixed(0) + '" y1="' + pA[1].toFixed(0) + '" x2="' + pB[0].toFixed(0) + '" y2="' + pB[1].toFixed(0) + '" stroke="#6b675c" stroke-width="1.5"/>';
      }
    }
    var named = [];
    for (i = 0; i < NS; i++) {
      if (!pos[i]) continue;
      var st = K.s[i], r = st[3] < 0.5 ? 5 : (st[3] < 1.6 ? 3.5 : 2.2);
      svg += '<circle cx="' + pos[i][0].toFixed(0) + '" cy="' + pos[i][1].toFixed(0) + '" r="' + r + '" fill="currentColor"/>';
      if (st[3] < 1.3 && st[0]) named.push([pos[i], st[0]]);
    }
    for (i = 0; i < K.v.length; i++) {           // 頂点専用は最小の点。ラベルは出さない
      var pv = pos[NS + i];
      if (pv) svg += '<circle cx="' + pv[0].toFixed(0) + '" cy="' + pv[1].toFixed(0) + '" r="1.4" fill="currentColor"/>';
    }
    var pls = ASTRO.planets(t).concat([(function () { var m = ASTRO.moonEq(t); return { n: '月', ra: m.ra, dec: m.dec, t: 'moon' }; })()]);
    for (i = 0; i < pls.length; i++) {
      var pa = ASTRO.altAz(pls[i].ra, pls[i].dec, me[0], me[1], t);
      var pd = CORE.angDiff(pa.az, ht);
      if (pa.alt < vLo || pa.alt > vHi || Math.abs(pd) > HALF) continue;
      var xx = stripX(pd, HALF), yy = sy(pa.alt);
      svg += '<circle cx="' + xx.toFixed(0) + '" cy="' + yy.toFixed(0) + '" r="5" fill="none" stroke="currentColor" stroke-width="2"/>';
      named.push([[xx, yy], pls[i].n]);
    }
    for (i = 0; i < Math.min(named.length, 5); i++) {
      svg += '<text x="' + named[i][0][0].toFixed(0) + '" y="' + (named[i][0][1] - 10).toFixed(0) + '" fill="currentColor" font-size="18" text-anchor="middle" font-family="inherit">' + named[i][1] + '</text>';
    }
    svg += '</svg>';
    return identShell('<div class="abs" style="top:10px;color:' + (S.night ? '#b04040' : '#f5f1e6') + '">' + svg + '</div>' +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">' + vis + '星 ／ 仰角' +
      Math.round(vLo) + '〜' + Math.round(vHi) + '°' + (pitchOk ? '' : '(既定)') +
      ' ／ ↑↓ 地上へ ／ 夜間はシステム輝度を最低に</span></div>');
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
  var NSEL = function () { return BUILT.length + 1; };   // 最後の1枠が「ここから」
  function scrSelect() {
    var dots = '';
    for (var i = 0; i < NSEL(); i++) dots += (i === S.routeIdx ? '●' : '○');
    if (S.routeIdx === BUILT.length) {                     // その場モード
      return '<div class="abs ctr" style="top:34px"><span class="screen-title dim">ルート選択</span></div>' +
        '<div class="abs" style="top:150px;left:20px" ><span class="navlr dim">‹</span></div>' +
        '<div class="abs" style="top:150px;right:20px;left:auto;width:40px"><span class="navlr dim">›</span></div>' +
        '<div class="abs ctr" style="top:120px;padding:0 80px"><span class="route-name main-c">ここから</span></div>' +
        '<div class="abs ctr" style="top:230px"><div class="stat-row">ルート無しのフリー走行</div>' +
        '<div class="stat-row sub dim" style="margin-top:8px">星・透視・距離・ペース・等高線が使えます</div>' +
        '<div class="stat-row sub dim">残距離/CT/ETA/逸脱は出ません(ルートが無いので)</div></div>' +
        '<div class="abs ctr" style="top:400px"><span class="dots dim">' + dots + '</span></div>' +
        '<div class="abs ctr" style="bottom:28px"><span class="hint dim">←→ 選択　ピンチ 決定</span></div>' +
        '<div class="abs" style="bottom:6px;right:10px;left:auto;text-align:right"><span class="sub dim">build ' +
        (typeof BUILD !== 'undefined' ? BUILD : '?') + (SIM ? ' SIM' : '') + '</span></div>';
    }
    var r = BUILT[S.routeIdx];
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
  function scrReadyFree() {
    var g = S.readyGeo || DIAG.raw;
    var pos = g ? g.la.toFixed(4) + ', ' + g.lo.toFixed(4) + ' ±' + Math.round(g.acc) + 'm' : '取得中…';
    var set = g ? CORE.fmtClock(CORE.sunTimes(g.la, g.lo, nowDate()).sunset) : '--:--';
    var goal = S.freeGoal ? (S.freeGoal / 1000) + 'km' : 'なし';
    return '<div class="abs ctr" style="top:40px"><span class="route-name">ここから</span></div>' +
      '<div class="abs" style="top:150px;padding:0 90px"><div class="frame">' +
      '<div class="stat-row">現在地 <span class="' + (g ? 'main-c' : 'dim') + '">' + pos + '</span></div>' +
      '<div class="stat-row">日没　 ' + set + '</div>' +
      '<div class="stat-row">目標　 <span class="dim">◂ </span><span class="main-c">' + goal + '</span><span class="dim"> ▸</span></div>' +
      '</div></div>' +
      '<div class="abs ctr" style="top:352px"><span class="sub dim">←→ 目標距離(なし / 5km / 10km)</span><br>' +
      '<span class="sub dim">星・透視・等高線はどこでも動きます</span></div>' +
      (S.perm ? '<div class="abs ctr" style="top:420px;padding:0 40px"><span class="sub acc2">' + esc(S.perm) + '</span></div>' : '') +
      '<div class="abs ctr" style="bottom:28px"><span class="hint ' + (S.starting ? 'dim' : 'main-c') + '">' +
      (S.starting ? '確認中…' : 'ピンチで計測開始') + '</span><span class="hint dim">　戻る: 選択へ</span></div>' +
      '<div class="abs ctr" style="bottom:56px"><span class="sub dim">' + (S.diag ? '' : '↓ センサー診断') + '</span></div>' + diagHtml();
  }
  function scrReady() {
    if (S.freeSel) return scrReadyFree();
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
      '<div>β:' + v(DIAG.beta) + ' γ:' + v(DIAG.gamma) + ' → ピッチ:' + v(S.pitch) +
      '°<span class="dim">(水平を向いて0付近なら正)</span></div>' +
      '<div>真方位:' + v(headingTrue()) + '°(偏角' + ((S.route && S.route.dec) || 7.5) + '西)</div>' +
      '<div class="dim">reg:' + ((S.route && S.route.reg) ? S.route.reg.length : 0) + '件 星:' + (sky().s.length + sky().v.length) + '(線用' + sky().v.length + ') Lap:' + S.lap + '</div>' +
      '<div class="dim">星表: HYG Database (CC BY-SA) ／ 星座線: Stellarium</div>' +
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
    // C-2: ゴーストの「後方○m」はデルタバー(時間差)に置き換える。距離より時間のほうが行動に効く
    var dbar = (band.ghost || !band.s) ? ghostDeltaHtml() : '';
    var bandHtml = dbar
      ? '<div class="abs z-band" style="line-height:0;padding-top:3px">' + dbar + '</div>'
      : '<div class="abs z-band ' + band.c + '">' + esc(band.s) + '</div>';
    var ov = ghostOverlayHtml();
    // C-5: 方位テープを最上段に置き、既存の中身はまとめて下げる(ラッパ1枚で済ませる)
    var tape = headingTape();
    var wrap = function (inner) {
      return tape + '<div style="position:absolute;left:0;right:0;top:46px;bottom:0">' + inner + '</div>';
    };
    if (S.panel === 0) return wrap(head + panelProgress() + turnaroundHtml() + ov) + bandHtml;
    if (S.panel === 1) return wrap(head + panelProfile() + ov) + bandHtml;
    if (S.panel === 2) return wrap(head + panelMap() + ov) + bandHtml;
    if (S.panel === 3) return wrap(head + panelWp()) + bandHtml;
    return wrap(head + panelWx()) + bandHtml;
  }
  function staleInfo() {
    var s = S.lastGoodFixReal ? (Date.now() - S.lastGoodFixReal) / 1000 : Infinity;
    return { sec: s, txt: s > 90 ? '(' + Math.round(s / 60) + '分前の位置)' : '' };
  }
  function panelProgressFree() {
    var st = staleInfo();
    if (!S.lastFix || st.sec > 600) {
      return '<div class="abs z-big ctr"><div class="big2 dim" style="margin-top:40px">GPS待ち…</div></div>' +
        '<div class="abs z-eta ctr"><div class="eta2">' + sunsetHtml() + '</div></div>';
    }
    var el = (nowMs() - S.startMs) / 60000, v = vmgNow();
    var paceTxt = (v != null && v > 0.05) ? (function (spk) { var mm = Math.floor(spk / 60), ss = Math.round(spk % 60);
      return mm + ':' + (ss < 10 ? '0' : '') + ss + '/km'; })(1000 / v) : '--/km';
    var goal = S.route.total;
    var big2 = goal ? '残 ' + CORE.fmtKm(Math.max(0, goal - S.along)) + (S.freeDone ? ' <span class="acc2">到達</span>' : '')
                    : '経過 ' + CORE.fmtDur(el);
    return '<div class="abs z-big ctr" style="margin-top:-90px"><div class="sub dim">' + esc(S.route.name) + '</div>' +
      '<div class="big1 ' + (st.sec > 90 ? 'dim' : 'main-c') + '">' + CORE.fmtKm(S.along) + '</div>' +
      '<div class="big2 ' + (st.sec > 90 ? 'dim' : 'main-c') + '">' + big2 +
      (st.txt ? ' <span class="sub acc2">' + st.txt + '</span>' : '') + '</div></div>' +
      '<div class="abs z-eta ctr"><div class="eta1">' + (goal ? '経過 ' + CORE.fmtDur(el) + ' ・ ' : '') + paceTxt + '</div>' +
      '<div class="eta2">' + sunsetHtml() + '</div></div>' +
      '<div class="abs z-ct ctr"><span class="ct1 dim">実効 ' + vmgText() + (S.moving ? '' : ' <span class="acc2">停止中</span>') + '</span></div>';
  }
  function panelProgress() {
    if (isFree()) return panelProgressFree();
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
      '<div class="arrow-lbl dim">' + (S.dev && S.dev.state.deviated ? '<span class="acc1">復帰方向</span>' : 'ルート先') + '</div>' +
      '<div style="line-height:0">' + crossTrackHtml() + '</div></div>' +
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
    if (isFree()) return '<div class="abs ctr" style="top:200px"><span class="eta1 dim">WPなし</span>' +
      '<div class="sub dim" style="margin-top:14px">その場モードにはポイントがありません</div></div>';
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
    if (isFree() && S.ghostSrc !== 'pace') return null;
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
    if (isFree()) return '<div class="abs ctr" style="top:200px"><span class="eta1 dim">断面図なし</span>' +
      '<div class="sub dim" style="margin-top:14px">ルート無しでは標高プロファイルを出せません</div></div>';
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
    // ラベルのソースと同じゴーストで比べる(以前は lap1/last でも標準CT差を出していた)。
    // 符号はこのパネルの慣例どおり「+ = 自分が遅い」
    var gdl = ghostDeltaNow();
    var diff = (gdl == null) ? '--' : CORE.fmtDiff(-gdl / 60);
    var gLbl = { ct: '標準CT', lap1: '1周目の自分', last: '前回の自分', pace: '目標ペース' }[S.ghostSrc] || '標準CT';
    return '<div class="abs ctr" style="top:60px">' + svg + '</div>' +
      '<div class="abs ctr" style="top:340px"><span class="eta1">' +
      Math.round(S.proj ? r.pts[CORE.routePointAt(r, S.along).seg][2] : r.pts[0][2]) + 'm</span>' +
      '<span class="dim ct1"> ／ 最高 ' + Math.round(eMax) + 'm</span></div>' +
      '<div class="abs ctr" style="top:392px"><span class="ct1 dim">ゴースト(' + gLbl + ') ' + diff + '</span></div>';
  }

  /* ---- 地形レイヤ(N2改: 地理院 標高タイル(数値DEM)をデコードして等高線を自前描画) ----
     旧実装は hillshademap(誰かが描いた影絵ラスタ)を z13固定で取得して反転していた。
     数値DEMなら加算ディスプレイ向けの明度設計を自分で持てる: 黒地に線だけを置き、
     グレー階調のベタ塗りを一切作らない(ガイドの配色原則)。等高線間隔は起伏レンジから自動。 */
  var terrCache = {};   // key → {url, fail, step}
  var demGrids = {};    // 'src/z/x/y' → Array(256*256) の標高(null=無効) | 'fail'
  function lon2tx(lo, z) { return (lo + 180) / 360 * Math.pow(2, z); }
  function lat2ty(la, z) {
    var r = la * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
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
  // 5mメッシュ(航空レーザ)はz15。山岳部に欠損域があるので10mメッシュ(〜z14)へフォールバックする
  function demSrc(z) { return z >= 15 ? 'dem5a_png' : 'dem_png'; }
  function demUrl(src, z, x, y) {
    return 'https://cyberjapandata.gsi.go.jp/xyz/' + src + '/' + z + '/' + x + '/' + y + '.png';
  }
  function demZoomFor(geo, maxTiles) {          // タイル枚数が収まる最大ズーム
    for (var z = 15; z > 10; z--) {
      var n = (Math.floor(lon2tx(geo.maxLo, z)) - Math.floor(lon2tx(geo.minLo, z)) + 1) *
              (Math.floor(lat2ty(geo.minLa, z)) - Math.floor(lat2ty(geo.maxLa, z)) + 1);
      if (n <= maxTiles) return z;
    }
    return 11;
  }
  function prefetchTiles() {                    // 回廊タイル先読み(SWがTILESへ保存)
    if (SIM || typeof fetch !== 'function') return;
    try {
      var z = 14, ts = routeTiles(S.route, z, 0).slice(0, 40);
      for (var i = 0; i < ts.length; i++) fetch(demUrl(demSrc(z), z, ts[i][0], ts[i][1]))['catch'](function () {});
    } catch (e) {}
  }
  function loadDemTile(src, z, x, y, cb) {      // → 標高配列 / 失敗はnull
    var k = src + '/' + z + '/' + x + '/' + y;
    if (demGrids[k]) { cb(demGrids[k] === 'fail' ? null : demGrids[k]); return; }
    var im = new Image();
    im.crossOrigin = 'anonymous';               // canvasを汚さない(getImageDataに必須)
    im.onload = function () {
      try {
        var cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
        var cx = cv.getContext('2d');
        cx.drawImage(im, 0, 0, 256, 256);       // 不透明描画。アルファ合成で値を壊さない
        var d = cx.getImageData(0, 0, 256, 256).data, g = new Array(65536);
        for (var i = 0, j = 0; j < 65536; i += 4, j++) g[j] = CORE.demElev(d[i], d[i + 1], d[i + 2]);
        demGrids[k] = g; cb(g);
      } catch (e) { demGrids[k] = 'fail'; cb(null); }
    };
    im.onerror = function () { demGrids[k] = 'fail'; cb(null); };
    im.src = demUrl(src, z, x, y);
  }
  var GRID = 2;   // 標高グリッドの画面上の刻み(px)。等高線の滑らかさと計算量のバランス
  var RIDGE_ON = false;   // 尾根線/谷線は抽出が安定するまで描かない(A-2 次段)
  function buildTerrain(key, geo, W, H) {   // geo: {unpx(x,y)→[lo,la], minLa..} 相当のマッパ
    if (terrCache[key]) return;
    terrCache[key] = { url: null, fail: false, step: null };
    if (typeof document === 'undefined' || !document.createElement) { terrCache[key].fail = true; return; }
    var tl = geo.unpx(0, 0), br = geo.unpx(W, H);      // 取得範囲はルートbboxでなく画面の四隅から(余白も埋める)
    var g2 = { unpx: geo.unpx,
               minLo: Math.min(tl[0], br[0]), maxLo: Math.max(tl[0], br[0]),
               minLa: Math.min(tl[1], br[1]), maxLa: Math.max(tl[1], br[1]) };
    fetchDem(key, g2, W, H, demZoomFor(g2, 12), false);
  }
  function fetchDem(key, geo, W, H, z, force10m) {
    var src = force10m ? 'dem_png' : demSrc(z);
    if (src === 'dem_png' && z > 14) z = 14;
    var x0 = Math.floor(lon2tx(geo.minLo, z)), x1 = Math.floor(lon2tx(geo.maxLo, z));
    var y0 = Math.floor(lat2ty(geo.maxLa, z)), y1 = Math.floor(lat2ty(geo.minLa, z));
    var need = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (need > 24) { terrCache[key].fail = true; return; }
    var got = 0, done = 0, tiles = {};
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        (function (tx, ty) {
          loadDemTile(src, z, tx, ty, function (g) {
            if (g) { tiles[tx + '/' + ty] = g; got++; }
            if (++done < need) return;
            if (src === 'dem5a_png' && got * 2 < need) { fetchDem(key, geo, W, H, 14, true); return; }
            if (got === 0) { terrCache[key].fail = true; render(); return; }   // 未取得は線図のまま(縮退)
            drawContours(key, geo, W, H, z, tiles);
          });
        })(tx, ty);
      }
    }
  }
  function drawContours(key, geo, W, H, z, tiles) {
    try {
      var gw = Math.floor(W / GRID) + 1, gh = Math.floor(H / GRID) + 1;
      var grid = new Array(gw * gh), mn = 1e9, mx = -1e9, valid = 0;
      for (var gy = 0; gy < gh; gy++) {
        for (var gx = 0; gx < gw; gx++) {
          var ll = geo.unpx(gx * GRID, gy * GRID);
          var fx = lon2tx(ll[0], z), fy = lat2ty(ll[1], z);
          var tx = Math.floor(fx), ty = Math.floor(fy), g = tiles[tx + '/' + ty], v = null;
          if (g) {
            var ix = Math.max(0, Math.min(255, Math.floor((fx - tx) * 256)));
            var iy = Math.max(0, Math.min(255, Math.floor((fy - ty) * 256)));
            v = g[iy * 256 + ix];
          }
          grid[gy * gw + gx] = v;
          if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; valid++; }
        }
      }
      if (valid < gw * gh * 0.2) { terrCache[key].fail = true; render(); return; }  // 大半が無効域
      // 起伏が10m未満なら線を引かない。平坦地の等高線は岸壁段差と建物基壇しか描かず
      // 意味ありげなノイズになる(A-1 で晴海の実機確認)。皇居(24m)は残り、晴海(3m)は落ちる
      if (mx - mn < 10) { terrCache[key].flat = true; terrCache[key].fail = true; render(); return; }
      // SPEC A-2: 階層化。主曲線10m(最暗)/計曲線50m(中)/尾根線(最明)/谷線(青系)。
      // 10mが数px間隔に潰れる急斜面では主曲線を落として計曲線だけにする(密度ガード)
      var STEP_MAIN = 10, STEP_INDEX = 50;
      var g60 = CORE.gradPercentile(grid, gw, gh, GRID, 0.6);
      var drawMain = !g60 || (STEP_MAIN / g60) >= 4;
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var cx = cv.getContext('2d');
      if (!cx) { terrCache[key].fail = true; render(); return; }
      cx.lineCap = 'round';
      var k0 = Math.ceil(mn / STEP_MAIN), k1 = Math.floor(mx / STEP_MAIN), drew = 0;
      for (var k = k0; k <= k1; k++) {
        var lv = k * STEP_MAIN, isIndex = (lv % STEP_INDEX === 0);
        if (!isIndex && !drawMain) continue;
        var segs = CORE.marchingSquares(grid, gw, gh, lv);
        if (!segs.length) continue;
        cx.strokeStyle = isIndex ? '#6b675c' : '#33302b';
        cx.lineWidth = isIndex ? 2 : 1;
        cx.beginPath();
        for (var i = 0; i < segs.length; i += 4) {
          cx.moveTo(segs[i] * GRID, segs[i + 1] * GRID);
          cx.lineTo(segs[i + 2] * GRID, segs[i + 3] * GRID);
        }
        cx.stroke(); drew++;
      }
      // 尾根線(最明)と谷線(青系)。高尾山の実タイルで画素を数えたところ尾根線は52px しか
      // 立たず(谷線441px)、稜線の背は1セル差が小さすぎて閾値で拾えない = 抽出が不安定。
      // SPEC A-2 の逃げ道どおり、まず計曲線+主曲線だけで出す。関数とテストは残してある
      if (RIDGE_ON) {
        var rv = CORE.ridgeValley(grid, gw, gh, 0.8 * (g60 || 0.5) * GRID);
        cx.lineWidth = 1.5;
        cx.strokeStyle = '#2e4650'; cx.beginPath();
        for (i = 0; i < rv.v.length; i += 4) { cx.moveTo(rv.v[i] * GRID, rv.v[i + 1] * GRID); cx.lineTo(rv.v[i + 2] * GRID, rv.v[i + 3] * GRID); }
        cx.stroke();
        cx.strokeStyle = '#c9c4b6'; cx.beginPath();
        for (i = 0; i < rv.r.length; i += 4) { cx.moveTo(rv.r[i] * GRID, rv.r[i + 1] * GRID); cx.lineTo(rv.r[i + 2] * GRID, rv.r[i + 3] * GRID); }
        cx.stroke();
      }
      var step = drawMain ? STEP_MAIN : STEP_INDEX;
      terrCache[key].step = drew ? step : null;
      terrCache[key].url = drew ? cv.toDataURL() : null;
      terrCache[key].fail = !drew;                       // 平坦すぎて線が出ない場合も線図に縮退
      render();
    } catch (e) { terrCache[key].fail = true; render(); }
  }

  /* ---- 街中の地図(N2改: 焼き込み済みOSM道路ベクタ) ----
     平坦地はDEMを良くしても無地。ラスタ地図の反転は細線が灰色のモヤになって
     加算ディスプレイで死ぬので、線を自前で引く。等高線と同じく非活性色1色にして、
     道路クラスは太さ・鉄道と水域は線種で区別する(色数を増やさない)。 */
  var vecCache = {};
  function drawVec(r, geo, W, H) {
    try {
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var cx = cv.getContext('2d');
      if (!cx) return null;
      cx.strokeStyle = '#6b675c'; cx.lineCap = 'round'; cx.lineJoin = 'round';
      var LY = [['water', 1, [1, 4]], ['rail', 1.5, [8, 5]], ['road', 0, null]];
      var drew = 0;
      for (var li = 0; li < LY.length; li++) {
        var g = r.vec[LY[li][0]];
        if (!g) continue;
        for (var i = 0; i < g.length; i++) {
          var cls = g[i][0], line = g[i][1];
          cx.lineWidth = LY[li][1] || (cls >= 4 ? 2.5 : (cls >= 3 ? 2 : (cls >= 2 ? 1.4 : 1)));
          if (cx.setLineDash) cx.setLineDash(LY[li][2] || []);
          cx.beginPath();
          for (var j = 0; j < line.length; j++) {
            var q = geo.px(line[j][1], line[j][0]);
            if (j === 0) cx.moveTo(+q[0], +q[1]); else cx.lineTo(+q[0], +q[1]);
          }
          cx.stroke(); drew++;
        }
      }
      if (cx.setLineDash) cx.setLineDash([]);
      if (!drew) return null;
      cx.clearRect(0, H - 32, 190, 32);          // スケールバー
      cx.clearRect(W - 56, 0, 56, 30);           // N↑
      cx.clearRect(W - 400, H - 26, 400, 26);    // クレジット
      return cv.toDataURL();
    } catch (e) { return null; }
  }

  // ルート形状図: 地図タイルは出さない(非ゴール)が、線と点の俯瞰なら軽量で読める。
  // 現在地の色はGPS精度で変える(カシミール3D方式: 良→悪 黄/橙/赤、途絶は灰)
  function freeTrackPts() {                             // その場モードの軌跡(15秒ごと)+現在地
    var out = [];
    for (var i = 0; i < S.track.length; i++) out.push([S.track[i][1], S.track[i][2], 0]);
    if (S.lastFix) out.push([S.lastFix.la, S.lastFix.lo, 0]);
    if (!out.length) out.push([S.route.pts[0][0], S.route.pts[0][1], 0]);
    return out;
  }
  function panelMap() {
    var r = S.route, pts = isFree() ? freeTrackPts() : r.pts;
    var lat0 = pts[0][0], klon = Math.cos(lat0 * Math.PI / 180) * 111320, klat = 110540;
    var xs = [], ys = [], i;
    for (i = 0; i < pts.length; i++) { xs.push(pts[i][1] * klon); ys.push(pts[i][0] * klat); }
    var fx = null, fy = null, devd = S.dev ? S.dev.state.dist : 1e9;
    if (S.lastFix && devd < 2500) { fx = S.lastFix.lo * klon; fy = S.lastFix.la * klat; xs.push(fx); ys.push(fy); }
    var minx = Math.min.apply(0, xs), maxx = Math.max.apply(0, xs);
    var miny = Math.min.apply(0, ys), maxy = Math.max.apply(0, ys);
    if (maxx - minx < 400) { var cxm = (minx + maxx) / 2; minx = cxm - 200; maxx = cxm + 200; }   // 最小400m四方
    if (maxy - miny < 300) { var cym = (miny + maxy) / 2; miny = cym - 150; maxy = cym + 150; }
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
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">';
    if (isFree()) {                                     // 軌跡だけ(通過済みの色)。ルートは無い
      var tr = []; for (i = 0; i < pts.length; i++) tr.push(px(pts[i][1], pts[i][0]));
      if (tr.length > 1) svg += '<path d="' + path(tr) + '" fill="none" stroke="#6b675c" stroke-width="4" stroke-linejoin="round"/>';
      var sp0 = px(r.pts[0][1], r.pts[0][0]);
      svg += '<circle cx="' + sp0[0] + '" cy="' + sp0[1] + '" r="6" fill="#f5f1e6"/>';
    } else {
    // 通過済み/残りで色分け
    var splitIdx = 0;
    while (splitIdx + 1 < r.cum.length && r.cum[splitIdx + 1] < S.along) splitIdx++;
    var pj = CORE.routePointAt(r, S.along);
    var done = [], todo = [[px(pj.lo, pj.la)[0], px(pj.lo, pj.la)[1]]];
    for (i = 0; i <= splitIdx; i++) done.push(px(pts[i][1], pts[i][0]));
    done.push(px(pj.lo, pj.la));
    for (i = splitIdx + 1; i < pts.length; i++) todo.push(px(pts[i][1], pts[i][0]));
    svg += '<path d="' + path(todo) + '" fill="none" stroke="#ffd83b" stroke-width="4" stroke-linejoin="round"/>';
    if (done.length > 1) svg += '<path d="' + path(done) + '" fill="none" stroke="#6b675c" stroke-width="4" stroke-linejoin="round"/>';
    }
    for (i = 0; i < (isFree() ? 0 : r.wps.length); i++) {
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
    svg += '<text x="' + pad + '" y="' + (H - 16) + '" fill="#6b675c" font-size="18" font-family="inherit">' + (bar >= 1000 ? (bar / 1000) + 'km' : bar + 'm') + '</text>';
    svg += '<text x="' + (W - 34) + '" y="24" fill="#6b675c" font-size="18" font-family="inherit">N↑</text>';
    svg += '</svg>';
    var cap;
    if (isFree()) cap = '走行 ' + CORE.fmtKm(S.along) + (S.lastFix && S.lastFix.acc != null ? '　±' + Math.round(S.lastFix.acc) + 'm' : '');
    else if (devd >= 2500) cap = 'ルート範囲外 (現在地は図の外)';
    else if (offRouteNow()) cap = '<span class="acc2">ルート外</span> ・ ルートまで ' + CORE.fmtKm(devd);
    else cap = '残 ' + CORE.fmtKm(Math.max(0, r.total - S.along)) + (S.lastFix && S.lastFix.acc != null ? '　±' + Math.round(S.lastFix.acc) + 'm' : '');
    var rawCap = S.lastFix
      ? S.lastFix.la.toFixed(5) + ', ' + S.lastFix.lo.toFixed(5) + ' (' + Math.round((Date.now() - S.lastFixReal) / 1000) + '秒前)'
      : '測位待ち';
    // 地形レイヤ(N2): キャッシュ済みなら下敷きに。失敗・未取得は線図のまま(仕様の縮退)
    var tKey = r.id + ':' + (r.rotatedFrom || 0) + ':' + Math.round(minx) + ':' + Math.round(miny) + ':' + sc.toFixed(4);
    var geoM = { minLo: (minx) / klon, maxLo: maxx / klon, minLa: miny / klat, maxLa: maxy / klat,
                 px: function (lo, la) { return px(lo, la); },
                 unpx: function (x, y) {   // px() の逆(アフィンなので解析的に戻せる)
                   return [(((x - ox) / sc) + minx) / klon, ((((H - y) - oy) / sc) + miny) / klat];
                 } };
    // 街中(urban)の地図: 道路ベクタがあればそれ。無ければ地形は描かない。
    // 実機(晴海)で確認したとおり、平坦地の等高線は岸壁段差と建物基壇しか描かず
    // 意味ありげなノイズにしかならない = 正直さゲートの逆(SPEC A-1)
    var isUrban = (r.domain === 'urban');
    var useVec = !!(r.vec && isUrban);
    var under = '', credit;
    if (useVec) {
      if (!(tKey in vecCache)) vecCache[tKey] = drawVec(r, geoM, W, H);
      credit = vecCache[tKey] ? '地図: © OpenStreetMap contributors' : '線図(地図未取得)';
      if (vecCache[tKey]) under = vecCache[tKey];
    } else if (isUrban) {
      credit = '';                        // 黒地+ルート+WPのみ。出典が無いのでクレジットも出さない
    } else {
      if (!terrCache[tKey]) buildTerrain(tKey, geoM, W, H);
      var terr = terrCache[tKey];
      if (terr && terr.url) {
        under = terr.url;
        // 山では OSM のベクタを描かない(等高線だけ)のでクレジットも地理院だけ。
        // 実データ化した山ルートは vec を持つが、描いていないものの出典を並べると1行に収まらず
        // スケールバーに重なる(高尾で実測)
        credit = '地図: 地理院タイル ・ 等高線' + (terr.step === 10 ? '10/50m' : '50m');
      } else {
        credit = (terr && terr.flat) ? '' : '線図(地形未取得)';   // 平坦=「無い」のではなく「引かない」
      }
    }
    credit = credit || '';
    under = under
      ? '<img src="' + under + '" width="' + W + '" height="' + H + '" style="position:absolute;left:0;top:0">'
      : '';
    return '<div class="abs ctr" style="top:44px"><div style="position:relative;width:' + W + 'px;height:' + H + 'px;display:inline-block">' + under +
      '<div style="position:absolute;left:0;top:0">' + svg + '</div>' +
      (credit ? '<div style="position:absolute;right:4px;bottom:2px;font-size:18px;color:#6b675c">' + credit + '</div>' : '') +
      '</div></div>' +
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
    return '<div class="abs ctr" style="top:50px"><span class="screen-title acc2">' + (f.free ? 'フリー走行サマリー' : '下山サマリー') + '</span></div>' +
      '<div class="abs" style="top:130px;padding:0 120px"><div class="frame">' +
      '<div class="stat-row">距離　　 ' + CORE.fmtKm(f.dist || 0) + '</div>' +
      '<div class="stat-row">所要　　 ' + CORE.fmtDur(f.elapsed || 0) + '</div>' +
      '<div class="stat-row">行動　　 ' + CORE.fmtDur(f.moving || 0) + '</div>' +
      '<div class="stat-row">休憩　　 ' + CORE.fmtDur(f.stop || 0) + '</div>' +
      (f.free ? '' : '<div class="stat-row">標準CT比 ' + (f.ctRatio ? f.ctRatio.toFixed(2) : '--') + '</div>') +
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
    else if (S.mode === 'detail') html = scrDetail();
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
  /* ---- 検証用ダンプ(docs/VERIFICATION.md の手順⑥⑦が使う) ----
     画面は絵しか出さないので、外部(Stellarium・解析値)と突き合わせるには数字が要る。 */
  function dumpSky() {
    if (!S.lastFix) return { error: 'GPS未取得。計測を開始してから実行する' };
    var t = nowMs(), me = [S.lastFix.la, S.lastFix.lo], out = [];
    function add(n, ra, dec) {
      var a = ASTRO.altAz(ra, dec, me[0], me[1], t);
      out.push({ name: n, az: +a.az.toFixed(2), alt: +a.alt.toFixed(2),
                 ra: +ra.toFixed(4), dec: +dec.toFixed(3) });
    }
    var pl = ASTRO.planets(t);
    for (var i = 0; i < pl.length; i++) add(pl[i].n, pl[i].ra, pl[i].dec);
    var mo = ASTRO.moonEq(t); add('月', mo.ra, mo.dec);
    var su = ASTRO.sunEq(t); add('太陽', su.ra, su.dec);
    var K = sky();
    for (i = 0; i < K.s.length; i++) if (K.s[i][0] && K.s[i][3] < 1.6) add(K.s[i][0], K.s[i][1], K.s[i][2]);
    return { at: new Date(t).toString(), lat: +me[0].toFixed(5), lon: +me[1].toFixed(5),
             heading: S.heading, headingTrue: headingTrue(), dec: S.route ? S.route.dec : null,
             objects: out };
  }
  function dumpGhost() {
    var gA = ghostAlongNow();
    var r = S.route, el = (nowMs() - S.startMs) / 60000;
    var lapEl = (nowMs() - (S.lapStartMs || S.startMs)) / 60000;
    return {
      src: S.ghostSrc, paceGoal: S.paceGoal, lap: S.lap,
      elapsedMin: +el.toFixed(3), lapElapsedMin: +lapEl.toFixed(3),
      total: r ? Math.round(r.total) : null,
      along: Math.round(S.along), ghostAlong: gA == null ? null : Math.round(gA),
      gapM: gA == null ? null : Math.round(S.along - gA),
      // 解析値: 目標ペースは等速なので位置が閉じた式で出る。これと ghostAlong が一致するはず
      expectPace: (S.ghostSrc === 'pace' && S.paceGoal > 0 && r)
        ? Math.round(Math.max(0, Math.min(r.total, r.total * ((isLoopRoute() ? lapEl : el) / S.paceGoal))))
        : null,
      expectCt: (S.ghostSrc === 'ct' && r) ? Math.round(CORE.ctInverse(r, el)) : null
    };
  }
  if (typeof window !== 'undefined') window.__THUD = { S: S, Geo: Geo, render: render, nowMs: nowMs, checkLapAndSegs: checkLapAndSegs, ghostAlongNow: ghostAlongNow, dumpSky: dumpSky, dumpGhost: dumpGhost, updateArrow: updateArrow, refreshHeadingView: refreshHeadingView, onFix: onFix, nRoutes: BUILT.length };
})();
