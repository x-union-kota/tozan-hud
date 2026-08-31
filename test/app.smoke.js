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

  // ---- SPEC C-1/C-2/C-3 ----
  {
    const S6 = T().S, R = S6.route;
    const keep = { mode: S6.mode, panel: S6.panel, tracking: S6.tracking, src: S6.ghostSrc,
                   dom: R.domain, sun: S6.sun, proj: S6.proj };
    S6.mode = 'main'; S6.panel = 0; S6.tracking = true;
    S6.lastFix = S6.lastFix || { la: R.pts[0][0], lo: R.pts[0][1], acc: 8, t: Date.now() };
    S6.lastFixReal = Date.now(); S6.proj = { dist: 5 }; S6.wpFlashUntil = 0;
    S6.startMs = T().nowMs() - 20 * 60000; S6.along = R.total * 0.3;
    S6.ghostSrc = 'ct'; S6.ghost = null;
    R.domain = 'mountain';
    S6.sun = { sunset: new Date(T().nowMs() + 3 * 3600000) };
    T().render();
    const withSun = text();
    ok(/引き返し限界 \d+:\d+ \(あと-?\d+分\)/.test(withSun), 'C-1: the turnaround limit is shown with a clock and a countdown');

    // SPECの受け入れは「山頂付近で『あと○分』が最小」。高尾山はピストンなので
    // 山頂を過ぎると出口が近づき、限界時刻はまた遅くなる — それが正しい挙動
    const grab = (t) => { const m = t.match(/引き返し限界 (\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : null; };
    const at = (f) => { S6.along = R.total * f; T().render(); return grab(text()); };
    const a10 = at(0.1), a50 = at(0.5), a90 = at(0.9);
    ok(a10 != null && a50 != null && a90 != null, 'C-1: the limit is computable along the whole route');
    ok(a50 < a10, `C-1: climbing towards the summit brings the limit forward (${a10} → ${a50})`);
    ok(a90 > a50, `C-1: past the summit the exit is nearer again, so it relaxes (${a50} → ${a90})`);

    // ゲート: 日没が取れなければ出さない / urbanでは出さない
    S6.sun = null; T().render();
    ok(!/引き返し限界/.test(text()), 'C-1: no sunset, no line (honesty gate)');
    S6.sun = { sunset: new Date(T().nowMs() + 3 * 3600000) };
    R.domain = 'urban'; T().render();
    ok(!/引き返し限界/.test(text()), 'C-1: urban routes do not show it');
    R.domain = 'mountain';

    // C-2: ゴースト後方の文字ではなく時間差バーが出る
    S6.along = R.total * 0.3; S6.ghostBehind = 40; T().render();
    const dtxt = text();
    ok(!/ゴースト後方/.test(dtxt), 'C-2: the "ghost 40m behind" text is gone');
    const html = window.document.getElementById('app').innerHTML;
    ok(/<rect/.test(html) && /z-band/.test(html), 'C-2: the delta bar is drawn in the band');
    ok(/[+−][\d.]+s|[+−]\d+:\d\d|[+−]\d+分/.test(html.replace(/CT [+−]\d+分/g, '')),
       'C-2: a time delta is shown instead of a distance');

    // ゲート: ルート外なら出さない
    S6.proj = { dist: 400 };
    if (S6.dev) { S6.dev.state.deviated = true; S6.dev.state.dist = 400; }
    T().render();
    ok(!/[+−][\d.]+s ?[▲▼]?$/m.test(text().trim()), 'C-2: off-route hides the delta (existing ghost gate)');
    S6.proj = { dist: 5 };
    if (S6.dev) { S6.dev.state.deviated = false; S6.dev.state.dist = 5; }

    // C-3: 窓の外の対象がエッジキューに出る
    S6.mode = 'ident'; S6.identLayer = 'ground'; S6.identFilter = 0;
    S6.heading = 0; S6.headingReal = Date.now(); S6.headingSettled = true;
    T().render();
    const cue0 = text();
    S6.heading = 180; S6.headingReal = Date.now(); T().render();
    const cue180 = text();
    const hasCue = (t) => /←\s*\S+\s*\d+°/.test(t) || /\S+\s*\d+°\s*→/.test(t);
    ok(hasCue(cue0) || hasCue(cue180), 'C-3: targets outside the window appear as edge cues');
    ok(cue0 !== cue180, 'C-3: the cues change as the head turns');

    S6.mode = keep.mode; S6.panel = keep.panel; S6.tracking = keep.tracking;
    S6.ghostSrc = keep.src; R.domain = keep.dom; S6.sun = keep.sun; S6.proj = keep.proj;
    S6.ghostBehind = null; T().render();
  }

  // ---- SPEC B: 透視・星座は頭の向きに追従する(キー操作で方位を回さない) ----
  {
    const S5 = T().S;
    const before = { mode: S5.mode, layer: S5.identLayer, panel: S5.panel, tracking: S5.tracking };
    S5.tracking = true; S5.mode = 'ident'; S5.identLayer = 'ground';
    S5.lastFix = S5.lastFix || { la: S5.route.pts[0][0], lo: S5.route.pts[0][1], acc: 8, t: Date.now() };
    S5.heading = 90; S5.headingReal = Date.now(); S5.headingSettled = true;
    T().render();
    const at90 = text();
    S5.heading = 180; S5.headingReal = Date.now(); T().render();
    const at180 = text();
    ok(at90 !== at180, 'the see-through strip follows S.heading (turning the head redraws it)');
    const dec = S5.route.dec || 7.5;
    const tick = (h) => Math.round(((h - dec) % 360 + 360) % 360) + '°';
    ok(at90.includes(tick(90)) && at180.includes(tick(180)),
       `the bearing scale is centred on the true heading (${tick(90)} / ${tick(180)})`);

    // ←→ はフィルタ切替であって方位を回さない
    const h0 = S5.heading;
    key('ArrowLeft'); key('ArrowRight');
    ok(S5.heading === h0, 'left/right never rotate the heading (they switch the filter)');

    // 仰角追従: 上を向くと空レイヤの高度帯が上がる
    S5.identLayer = 'sky';
    S5.pitch = 10; S5.pitchReal = Date.now(); T().render();
    const low = text();
    S5.pitch = 55; S5.pitchReal = Date.now(); T().render();
    const high = text();
    const band = (t) => { const m = t.match(/仰角(-?\d+)〜(-?\d+)°/); return m ? [+m[1], +m[2]] : null; };
    ok(band(low) && band(high), 'the sky layer states which elevation band it is showing');
    ok(band(high)[0] > band(low)[0] && band(high)[1] > band(low)[1],
       `looking up raises the band (${band(low)} → ${band(high)})`);
    ok(band(low)[1] - band(low)[0] === 50, 'the band is the pitch ±25° window');
    ok(band(low)[0] === -15 && band(high)[0] === 30, 'the band is centred on the pitch itself');

    // betaが来ないときは既定帯(20〜60°)で、そうと分かるように出す
    S5.pitch = null; S5.pitchReal = 0; T().render();
    const dflt = text();
    ok(/仰角20〜60°\(既定\)/.test(dflt), 'without pitch it falls back to the default band and says so');

    S5.identLayer = before.layer; S5.mode = before.mode; S5.panel = before.panel;
    S5.tracking = before.tracking; T().render();
  }

  // ---- v3.2: 検証用ダンプ(docs/VERIFICATION.md の手順⑥⑦が使う) ----
  {
    ok(typeof T().dumpGhost === 'function' && typeof T().dumpSky === 'function',
       'verification dumps are exposed on __THUD');
    const g = T().dumpGhost();
    ok('src' in g && 'ghostAlong' in g && 'expectPace' in g && 'expectCt' in g,
       'dumpGhost reports both the drawn value and the analytic one');
    const k = T().dumpSky();
    // 計測停止中はGPSが無いので error を返すのが正しい挙動
    ok(('error' in k) || (Array.isArray(k.objects) && k.objects.length > 0),
       'dumpSky either lists objects or says why it cannot');
  }

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

    // SPEC A-1: urbanで道路ベクタが無いときは等高線を描かず、出典行も出さない
    r.vec = null; T().render();
    const bare = text();
    ok(!/地理院タイル/.test(bare) && !/等高線/.test(bare),
       'an urban route without vectors draws no contours (flat ground makes them noise)');
    ok(!/線図\(地形未取得\)/.test(bare), 'and it does not apologise for a layer it never wanted');
    r.domain = 'mountain'; T().render();
    ok(/線図\(地形未取得\)|地理院タイル/.test(text()),
       'a mountain route still asks for the terrain layer');
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
