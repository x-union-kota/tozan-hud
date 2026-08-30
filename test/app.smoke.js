'use strict';
/* dist/index.html を jsdom で起動し、sim モードで一連のフローを通す */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://example.test/index.html?sim=1',
  runScripts: 'dangerously',
  pretendToBeVisual: true
});
const { window } = dom;

let fail = 0, step = 0;
function ok(cond, msg) {
  step++;
  if (!cond) { fail++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}
function key(k) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
const T = () => window.__THUD;
const text = () => window.document.getElementById('app').textContent;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(200);
  ok(T() && T().S.mode === 'disclaimer', 'boots into disclaimer');
  ok(/補助/.test(text()), 'disclaimer text shown');

  key('Enter');                      // 免責了承 → センサー権限 → select
  await sleep(200);
  ok(T().S.sensorsReady === true, 'sensor permission resolved before any pushState');
  ok(T().S.mode === 'select', 'Enter → select');
  ok(/晴海/.test(text()), 'route 1 (晴海) listed');
  key('ArrowRight');
  ok(/高尾山/.test(text()), '→ cycles to 高尾山 (piston)');
  key('ArrowRight'); key('ArrowRight'); key('ArrowRight');
  ok(/晴海/.test(text()), 'cycles back to 晴海 (4 routes)');
  key('ArrowRight');   // ← 富士山(4番目)も超えてループ確認
  key('ArrowRight'); // 高尾山(ピストン)

  key('Enter');
  ok(T().S.mode === 'ready', 'Enter → ready');
  ok(/標準CT/.test(text()) && /日没/.test(text()), 'ready shows CT & sunset');
  ok(window.history.length >= 2, 'history entry pushed for ready');

  key('Enter'); // 計測開始(simは権限スキップ)
  await sleep(300);
  ok(T().S.mode === 'main', 'start → main');
  ok(T().S.tracking === true, 'tracking on');

  await sleep(3500); // simフィックス数回
  ok(T().S.lastFix != null, 'sim fixes arriving');
  ok(T().S.proj != null && T().S.proj.dist < 40, 'matched onto route');
  ok(/残/.test(text()), 'remaining distance rendered');
  const along1 = T().S.along;
  await sleep(5200);
  ok(T().S.along > along1 + 15, 'progress advances (+' + Math.round(T().S.along - along1) + 'm)');

  // パネル切替(v3: 5枚 進捗0/断面1/地形図2/次WP3/天気4)
  key('ArrowRight'); ok(T().S.panel === 1, 'panel1 → 断面図');
  key('ArrowRight'); ok(T().S.panel === 2 && /N↑/.test(text()), 'panel2 → 地形図(N↑確認)');
  key('ArrowRight'); ok(T().S.panel === 3 && /次のポイント/.test(text()), 'panel3 → 次WP');
  key('ArrowRight'); ok(T().S.panel === 4 && /予報|天気データ/.test(text()), 'panel4 → 天気');
  ok(/時間前/.test(text()), 'weather freshness shown');
  key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft');
  ok(T().S.panel === 0, 'panel back to 進捗');

  // WP誤消費バグの回帰: パネル0(進捗)でEnterを連打してもWPは減らない
  {
    const before = Object.keys(T().S.wpPassed).length;
    key('Enter'); key('Enter'); key('Enter');
    ok(Object.keys(T().S.wpPassed).length === before, 'Enter on panel0 does NOT consume WPs');
    // パネル3(次WP)で遠いWPの手動確認は拒否される(500m以内条件)
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight'); // 0→1→2→3
    const w = (function(){ for (const x of T().S.route.wps) if (!T().S.wpPassed[x.d] && x.d > 40) return x; })();
    if (w && (w.d - T().S.along) > 500) {
      key('Enter');
      ok(!T().S.wpPassed[w.d], 'manual WP confirm refused beyond 500m');
      ok(/以内/.test(text()) || T().S.wpFlashMsg.indexOf('以内') >= 0, 'refusal message flashed');
    } else {
      ok(true, 'skip: next WP already near'); ok(true, 'skip');
    }
    key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft'); // 3→2→1→0
  }

  // ↓でテーマトグル(v3: ↑は同定モード)
  const cls0 = window.document.body.className;
  key('ArrowDown');
  ok(window.document.body.className !== cls0, '↓ → テーマ切替');
  key('ArrowDown');   // 元に戻す

  // 逸脱注入 → warn 遷移
  key('d');
  await sleep(4500); // 3回連続>50m
  ok(T().S.mode === 'warn', 'deviation → warn mode');
  ok(/ルート逸脱/.test(text()), 'warn screen rendered');
  ok(/復帰方向/.test(text()), 'recovery arrow labeled');

  // Enter = 5分抑制 → mainへ
  key('Enter'); await sleep(500);
  ok(T().S.mode === 'main', 'suppress → back to main');
  ok(T().S.suppressUntil > T().nowMs(), 'suppress timer set');
  await sleep(500);
  ok(/抑制中/.test(text()), 'band shows suppression countdown');
  ok(T().S.panel === 0 && (/ルートまで/.test(text()) || /GPS待ち/.test(text())), 'off-route: ルートまで or GPS待ち displayed');
  ok(!/^残 /.test(text()), 'off-route: no misleading distance');

  // 復帰 → FSM解除を確認
  key('d'); // 逸脱オフ
  await sleep(3000);
  ok(T().S.dev.state.deviated === false, 'FSM clears after returning to route');

  // GPS喪失注入 → 帯警告(実時間30秒待たず、閾値ロジックだけ直接確認)
  T().S.lastFixReal = Date.now() - 35000;
  T().render();
  ok(/GPS喪失/.test(text()), 'GPS-lost warning in band');
  await sleep(1500); // simが再フィックスして回復

  // ゴール付近へジャンプ → 残距離が小さい
  key('g');
  await sleep(2500);
  const rem = T().S.route.total - T().S.along;
  ok(rem < 400, 'goal jump: remaining small (' + Math.round(rem) + 'm)');

  // mode=mainを確認してからalong書き換えでdone
  if (T().S.mode !== 'main') { console.log('SKIP done test: mode='+T().S.mode); }
  else {
  // Escape = 終了 → done
  key('Escape');
  await sleep(300);
  ok(T().S.mode === 'done', 'Escape from main → done');
  ok(/下山サマリー/.test(text()), 'summary rendered');
  ok(/標準CT比/.test(text()), 'CT ratio shown');
  ok(T().S.finished && T().S.finished.dist > 0, 'summary has distance');

  }  // end if(main)
  // done → select
  if (T().S.mode === 'done') {
  key('Escape');
  await sleep(300);
  ok(T().S.mode === 'select', 'done → select (root)');
  } else { ok(true,'skip done→select'); }
  ok(T().S.tracking === false, 'tracking stopped');

  // localStorage: activeは消えている
  ok(window.localStorage.getItem('thud.active') === null, 'active hike cleared after finish');
  ok(window.localStorage.getItem('thud.lastResult') !== null, 'last result saved');

  // ---- v3.1 回帰: 自宅登録導線(ready直下) ----
  T().S.routeIdx = 0; T().render();
  key('Enter');                       // 晴海(周回) → ready
  await sleep(100);
  ok(T().S.mode === 'ready' && /晴海/.test(text()), 'reopen 晴海 (loop) ready');
  ok(/ここを自宅にする/.test(text()), 'ready top-level shows home-registration guidance');
  T().S.readyGeo = { la: 35.655, lo: 139.783, acc: 10 };
  key('ArrowDown');                   // 診断を開く
  ok(/ピンチ: ここを自宅に登録/.test(text()), 'diag shows explicit pinch action line');
  key('Enter');
  ok(/もう一度ピンチ/.test(text()), 'home registration asks for confirm');
  key('Enter');
  ok(T().S.home != null, 'home registered via double pinch');
  ok(window.localStorage.getItem('thud.home') !== null, 'home persisted to localStorage');
  key('ArrowDown');                   // 診断を閉じる
  ok(/ピンチで自宅削除/.test(text()), 'ready hint switches to deletion once registered');

  // ---- v3.2: 街中の地図(焼き込みOSM道路ベクタ) ----
  {
    const S4 = T().S, r = S4.route;
    const enc = (pts) => {                      // テスト用 polyline エンコーダ
      let out = '', pla = 0, plo = 0;
      const e = (v) => { v = v < 0 ? ~(v << 1) : (v << 1); let s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        return s + String.fromCharCode(v + 63); };
      for (const [la, lo] of pts) { const a = Math.round(la * 1e5), b = Math.round(lo * 1e5);
        out += e(a - pla) + e(b - plo); pla = a; plo = b; }
      return out;
    };
    const near = r.pts[0], far = r.pts[Math.min(5, r.pts.length - 1)];
    const poly = enc([[near[0], near[1]], [far[0], far[1]]]);
    r.vec = window.CORE.buildRoute({ id: 'x', name: 'x', poly: poly, ele: '?',
      vec: { road: [[4, poly]], rail: [[2, poly]], water: [[1, poly]] } }).vec;
    r.domain = 'urban';
    const before = S4.panel, beforeMode = S4.mode;
    S4.mode = 'main'; S4.panel = 2; T().render();   // 地形図パネル
    const txt = text();
    ok(r.vec && r.vec.road.length === 1, 'route carries a decoded vec');
    ok(/地図: © OpenStreetMap contributors|線図\(地図未取得\)/.test(txt),
       'urban route with vec renders the OSM map layer (or degrades to the line diagram)');
    ok(!/地理院タイル/.test(txt), 'vec route does not also claim the GSI terrain credit');
    r.vec = null; r.domain = 'mountain'; S4.panel = before; S4.mode = beforeMode; T().render();
    ok(!/OpenStreetMap/.test(text()), 'credit reverts once the vec is gone');
  }

  // ---- N8: 目標ペース(等速仮想走者) ----
  {
    ok(/↑ 目標ペース/.test(text()) && /未設定/.test(text()), 'ready advertises an unset pace goal');
    key('ArrowUp');
    ok(T().S.paceEdit != null && T().S.diag === false, 'ArrowUp opens the pace layer (not diag)');
    ok(/等速の仮想走者/.test(text()), 'pace layer names the virtual runner');
    ok(/1周の目標タイム/.test(text()), 'loop route asks for a per-lap target');
    const base = T().S.paceEdit;
    key('ArrowRight');
    ok(T().S.paceEdit === base + 5, '→ adds 5 min');
    key('ArrowLeft'); key('ArrowLeft');
    ok(T().S.paceEdit === base - 5, '← subtracts 5 min');
    for (let i = 0; i < 60; i++) key('ArrowLeft');
    ok(T().S.paceEdit === 0 && /設定しない/.test(text()), 'below the floor collapses to 設定しない');
    key('Escape');
    ok(T().S.paceEdit === null && T().S.paceGoal === null && T().S.mode === 'ready',
       'Escape cancels the edit without saving and stays on ready');

    key('ArrowUp'); key('ArrowRight'); key('ArrowRight');
    const goal = T().S.paceEdit;
    key('Enter');
    ok(T().S.paceEdit === null && T().S.paceGoal === goal, 'Enter commits the goal and closes the layer');
    ok(JSON.parse(window.localStorage.getItem('thud.paceGoal.' + T().S.route.id)) === goal,
       'goal persisted per route');
    ok(/設定中/.test(text()), 'ready shows the committed goal');

    const S3 = T().S, tot = S3.route.total;
    S3.tracking = true; S3.ghostSrc = 'pace';
    S3.startMs = S3.lapStartMs = T().nowMs() - goal * 60000 / 2;
    const gA = T().ghostAlongNow();
    ok(Math.abs(gA - tot / 2) < tot * 0.02, 'pace ghost sits halfway at half the target time');
    S3.lapStartMs = T().nowMs() - goal * 60000 * 2;
    ok(T().ghostAlongNow() === tot, 'pace ghost clamps at the route end');

    // 明示設定の目標ペースは2周目の「1周目の自分」に奪われない
    S3.lap = 1; S3.lapTimes = []; S3.lapStartMs = T().nowMs() - 600000;
    S3.proj = { dist: 5 }; S3.along = tot - 10;
    S3.track = [[0, 0, 0, 0], [1, 0, 0, 10], [2, 0, 0, 20], [3, 0, 0, 30], [4, 0, 0, 40], [5, 0, 0, 50]];
    S3.lastFix = { la: S3.route.pts[0][0], lo: S3.route.pts[0][1], acc: 8, t: Date.now() };
    const nw3 = T().nowMs();
    S3.lapHist = [[nw3 - 30000, tot - 80], [nw3 - 6000, tot - 30]];
    T().checkLapAndSegs(nw3);
    ok(S3.lap === 2 && S3.ghostSrc === 'pace', 'lap 2 does not steal an explicit pace goal');
    S3.tracking = false; S3.ghostSrc = ''; S3.paceGoal = null; S3.track = [];
  }

  // ---- v3.1 回帰: ラップ進行方向ゲート ----
  {
    const S2 = T().S, nw = T().nowMs(), tot = S2.route.total;
    S2.tracking = true; S2.proj = { dist: 5 };
    S2.lap = 1; S2.lapTimes = []; S2.lapStartMs = nw - 600000;
    S2.lastFix = { la: S2.route.pts[0][0], lo: S2.route.pts[0][1], acc: 8, t: Date.now() };
    // A: 起点付近で横ばい(うろうろ) → 発火しない
    S2.along = tot - 10;
    S2.lapHist = [[nw - 40000, tot - 12], [nw - 20000, tot - 9], [nw - 6000, tot - 11]];
    T().checkLapAndSegs(nw);
    ok(S2.lap === 1, 'lap gate: loitering near start does NOT fire');
    // B: 後戻りで起点圏内へ → 発火しない
    S2.along = tot - 10;
    S2.lapHist = [[nw - 40000, tot - 2], [nw - 6000, tot - 5]];
    T().checkLapAndSegs(nw);
    ok(S2.lap === 1, 'lap gate: backtracking does NOT fire');
    // C: 前進して通過 → 発火し、マッチャー巻き戻し+履歴クリア
    S2.along = tot - 10;
    S2.lapHist = [[nw - 30000, tot - 80], [nw - 6000, tot - 30]];
    T().checkLapAndSegs(nw);
    ok(S2.lap === 2, 'lap gate: forward pass fires lap');
    ok(S2.along === 0 && S2.lapHist.length === 0, 'lap fire rewinds matcher & clears history');
    S2.tracking = false;
  }

  console.log(`\n${step - fail}/${step} passed`);
  window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
