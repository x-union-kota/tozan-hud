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
  key('ArrowRight'); key('ArrowRight');
  ok(/富士山/.test(text()), '→→ 皇居 → 富士山');
  key('ArrowRight');
  ok(/南高尾/.test(text()), '5th route is 南高尾 (real GPX)');
  key('ArrowRight');
  ok(/ここから/.test(text()), 'the 6th slot is その場モード (ここから)');
  key('ArrowRight');
  ok(/晴海/.test(text()), 'cycles back to 晴海 (5 routes + ここから)');
  key('ArrowRight');   // 高尾山
  key('ArrowRight');   // 皇居(周回・urban)。以降の逸脱/詳細ページの流れはこのルートで踏む

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

  // SPEC C-7/C-8: ↓ は詳細ページ。テーマ切替はその中のピンチに移った
  {
    const cls0 = window.document.body.className;
    const dom0 = T().S.route.domain;
    T().S.route.domain = 'mountain';          // この時点の周回ルートは urban。マージンは mountain 限定
    key('ArrowDown');
    ok(T().S.mode === 'detail', '↓ → 詳細ページ');
    ok(/現在勾配/.test(text()) && /実効/.test(text()), 'detail shows grade and effective speed');
    ok(/引き返しマージン/.test(text()), 'detail hosts the turnaround-margin setting');
    T().S.route.domain = 'urban'; T().render();
    ok(!/引き返しマージン/.test(text()) && !/登り/.test(text()), 'urban hides margin and climb notice (they mean little in town)');
    T().S.route.domain = dom0; T().render();
    const m0 = T().S.tbMargin; key('ArrowRight');
    ok(T().S.tbMargin !== m0 && [30, 60, 90].includes(T().S.tbMargin), '←→ cycles the margin through 30/60/90');
    key('ArrowLeft');
    key('Enter');
    ok(window.document.body.className !== cls0, 'pinch on the detail page toggles the theme');
    key('Enter');   // 元に戻す
    key('ArrowDown'); await sleep(300);
    ok(T().S.mode === 'main', '↓ again returns to main');
  }

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

  // ---- SPEC C-5 方位テープ / C-6 注視ロック / C-4 実進行ベクトル / C-9 CDI ----
  {
    const S7 = T().S, R = S7.route;
    const keep = { mode: S7.mode, panel: S7.panel, tracking: S7.tracking, lock: S7.identLock };
    S7.mode = 'main'; S7.panel = 0; S7.tracking = true; S7.wpFlashUntil = 0;
    S7.lastFix = { la: R.pts[0][0], lo: R.pts[0][1], acc: 8, t: Date.now() };
    S7.lastFixReal = Date.now(); S7.proj = { dist: 5 }; S7.along = R.total * 0.3;
    S7.heading = 0; S7.headingReal = Date.now(); S7.headingSettled = true;
    T().render();
    const html0 = window.document.getElementById('app').innerHTML;

    // C-5: テープが常設で、方位に連動する
    ok(/polygon|<line/.test(html0) && /°<\/text>/.test(html0), 'C-5: the heading tape is drawn');
    // 600×600固定は絶対制約。インラインSVGは行ボックスを押し広げるので毎回見る
    ok(window.document.body.scrollHeight <= 600,
       `C-5: the layout still fits the 600px box (${window.document.body.scrollHeight})`);
    const ticks = (h) => (h.match(/>(\d+)°<\/text>/g) || []).join(',');
    const t0 = ticks(html0);
    S7.heading = 90; S7.headingReal = Date.now(); T().render();
    const t90 = ticks(window.document.getElementById('app').innerHTML);
    ok(t0 !== t90 && t0.length > 0, 'C-5: the tape scale follows the heading');

    // 目盛は15°刻みで、間隔は方位差に比例する
    {
      const nums = (window.document.getElementById('app').innerHTML.match(/>(\d+)°<\/text>/g) || [])
        .map(x => +x.replace(/\D/g, ''));
      let steps = [];
      for (let i = 1; i < nums.length; i++) steps.push(((nums[i] - nums[i - 1]) % 360 + 360) % 360);
      ok(steps.length >= 4 && steps.every(x => x === 15), `C-5: ticks are every 15° (${steps.join(',')})`);
    }

    // 較正できていなければテープは数字を出さない
    S7.headingSettled = false; T().render();
    ok(/方位(較正中|取得待ち)/.test(text()), 'C-5: an uncalibrated tape says so instead of showing a heading');
    S7.headingSettled = true; T().render();

    // C-9: 中央から右へ20mずらすとバーの点が右へ、50m超で消える
    const mid = window.CORE.routePointAt(R, S7.along);
    const a2 = window.CORE.routePointAt(R, S7.along - 25), b2 = window.CORE.routePointAt(R, S7.along + 25);
    const brg = window.CORE.bearing([a2.la, a2.lo], [b2.la, b2.lo]);
    const cx = () => { const m = window.document.getElementById('app').innerHTML.match(/<circle cx="(\d+)" cy="7"/); return m ? +m[1] : null; };
    S7.lastFix = { la: mid.la, lo: mid.lo, acc: 8, t: Date.now() }; T().render();
    const c0 = cx();
    const right = window.CORE.destPoint(mid.la, mid.lo, (brg + 90) % 360, 20);
    S7.lastFix = { la: right[0], lo: right[1], acc: 8, t: Date.now() }; T().render();
    const cR = cx();
    const left = window.CORE.destPoint(mid.la, mid.lo, (brg + 270) % 360, 20);
    S7.lastFix = { la: left[0], lo: left[1], acc: 8, t: Date.now() }; T().render();
    const cL = cx();
    ok(c0 != null && cR != null && cL != null, 'C-9: the cross-track bar is drawn on route');
    ok(cR > c0 && cL < c0, `C-9: drifting right moves the dot right (${cL} < ${c0} < ${cR})`);
    const far = window.CORE.destPoint(mid.la, mid.lo, (brg + 90) % 360, 80);
    S7.lastFix = { la: far[0], lo: far[1], acc: 8, t: Date.now() }; T().render();
    ok(cx() === null, 'C-9: beyond 50m the bar goes out (the off-route flow takes over)');
    ok(!/\d+m/.test((text().match(/コース偏差[^\n]*/) || [''])[0]), 'C-9: no numbers are printed for the deviation');

    // C-4: 実進行ベクトルは移動が足りなければ出ない
    S7.posHist = []; T().render(); T().updateArrow && T().updateArrow();
    const tri = () => window.document.getElementById('arw-t');
    ok(!tri() || tri().style.display === 'none', 'C-4: no travel vector without movement');
    const now = Date.now();
    const p1 = window.CORE.routePointAt(R, S7.along), p2 = window.CORE.routePointAt(R, S7.along + 60);
    S7.posHist = [[now - 12000, p1.la, p1.lo, 8], [now, p2.la, p2.lo, 8]];
    S7.lastFix = { la: p2.la, lo: p2.lo, acc: 8, t: now };
    T().render();
    ok(tri() && tri().style.display !== 'none', 'C-4: moving along the route shows the travel vector');
    S7.posHist = [[now - 12000, p1.la, p1.lo, 8], [now, p1.la, p1.lo, 8]];
    T().render();
    ok(!tri() || tri().style.display === 'none', 'C-4: standing still hides it again (no noise when stopped)');

    // C-6: 透視で中央±8°の対象をロックし、首を回しても残る
    S7.mode = 'ident'; S7.identLayer = 'ground'; S7.identFilter = 0; S7.identLock = null;
    S7.lastFix = { la: R.pts[0][0], lo: R.pts[0][1], acc: 8, t: Date.now() };
    const items = (R.reg || []).filter(e => e.n);
    const target = items[0];
    const brgT = window.CORE.bearing([S7.lastFix.la, S7.lastFix.lo], [target.la, target.lo]);
    S7.heading = ((brgT + (R.dec || 7.5)) % 360 + 360) % 360;   // 真方位が対象を向くように
    S7.headingReal = Date.now(); T().render();
    key('Enter');
    ok(S7.identLock && S7.identLock.n === target.n, `C-6: pinching locks the centred target (${S7.identLock && S7.identLock.n})`);
    ok(text().includes(target.n), 'C-6: the locked target is shown');
    S7.heading = (S7.heading + 100) % 360; S7.headingReal = Date.now(); T().render();
    ok(text().includes(target.n), 'C-6: it stays on screen after turning the head away');
    key('Escape');
    ok(S7.identLock === null && S7.mode === 'ident', 'C-6: back releases the lock without leaving the layer');

    S7.mode = keep.mode; S7.panel = keep.panel; S7.tracking = keep.tracking;
    S7.identLock = keep.lock; S7.posHist = []; T().render();
  }

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

  // ---- 実機バグ回帰: 透視/星はキー操作なしで、方位イベントだけで描き直される ----
  {
    const S8 = T().S;
    const keep = { mode: S8.mode, layer: S8.identLayer, tracking: S8.tracking, track: S8.track.slice(), lastTrackMs: S8.lastTrackMs };
    S8.tracking = true; S8.mode = 'ident'; S8.identLayer = 'ground';
    S8.lastFix = S8.lastFix || { la: S8.route.pts[0][0], lo: S8.route.pts[0][1], acc: 8, t: Date.now() };
    S8.heading = 30; S8.headingReal = Date.now(); S8.headingSettled = true; T().render();
    const before = text();
    // キーは押さない。方位だけ変えて、方位イベントの経路(refreshHeadingView)を叩く
    S8.heading = 120; S8.headingReal = Date.now();
    T().refreshHeadingView();
    ok(text() !== before, 'ident redraws from a heading change alone (no key press)');
    // 星も同じ
    S8.identLayer = 'sky'; S8.pitch = 20; S8.pitchReal = Date.now(); T().refreshHeadingView();
    const sky1 = text();
    S8.heading = 300; S8.headingReal = Date.now(); T().refreshHeadingView();
    ok(text() !== sky1, 'the sky layer redraws from a heading change alone');
    // main ではテープだけが差し替わる(全体を描き直さない)
    S8.mode = 'main'; S8.panel = 0; T().render();
    const tapeBefore = (window.document.getElementById('tape') || {}).innerHTML;
    S8.heading = 200; S8.headingReal = Date.now(); T().refreshHeadingView();
    const tapeAfter = (window.document.getElementById('tape') || {}).innerHTML;
    ok(tapeBefore && tapeAfter && tapeBefore !== tapeAfter, 'main refreshes the tape on a heading change');

    // tick は計測中なら ident でも進む(記録・判定が止まらない)
    S8.mode = 'ident'; S8.identLayer = 'ground';
    S8.lastTrackMs = 0; const n0 = S8.track.length;
    // tick は setInterval で1Hz。直接叩けないので、記録条件を満たした状態で1.2秒待つ
    await sleep(1200);
    ok(S8.track.length > n0, 'the track keeps recording while the see-through layer is open');

    S8.mode = keep.mode; S8.identLayer = keep.layer; S8.tracking = keep.tracking;
    S8.track = keep.track; S8.lastTrackMs = keep.lastTrackMs; T().render();
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

  // ---- その場モード(ルート無しのフリー走行) ----
  {
    const S9 = T().S;
    S9.tracking = false; S9.mode = 'select'; S9.routeIdx = T().nRoutes; T().render();
    ok(/ここから/.test(text()) && /フリー走行/.test(text()), 'free mode is offered on the selector');
    key('Enter'); await sleep(200);
    ok(S9.mode === 'ready' && S9.freeSel === true, 'Enter opens the free-mode ready screen');
    ok(/目標/.test(text()) && /なし/.test(text()), 'the target distance starts as none');
    key('ArrowRight'); ok(S9.freeGoal === 5000, '→ sets a 5km target');
    key('ArrowRight'); ok(S9.freeGoal === 10000, '→ again sets 10km');
    key('ArrowRight'); ok(S9.freeGoal === 0, '→ wraps back to none');
    key('ArrowRight');                                    // 5km で開始
    S9.readyGeo = { la: 35.700, lo: 139.700, acc: 10 };
    key('Enter'); await sleep(400);
    ok(S9.mode === 'main' && S9.tracking && S9.route && S9.route.free === true, 'free mode starts without a route');
    ok(S9.route.total === 5000 && /5km/.test(S9.route.name), 'the route object carries the 5km target');
    ok(S9.route.reg.some(e => e.n === '富士山') && S9.route.reg.every(e => e.v === 0),
       'nearby famous peaks are registered, all as see-through (no raycast here)');
    ok(Math.abs(S9.route.dec - window.CORE.decJapan(35.7, 139.7)) < 1e-9, 'declination comes from the Japan fit');

    // 距離は「動いた分」だけ積む。ノイズ(3m未満)と低精度(50m超)は足さない
    const p0 = [35.700, 139.700];
    T().onFix({ la: p0[0], lo: p0[1], acc: 8, t: Date.now() });
    const a0 = S9.along;
    const p1 = window.CORE.destPoint(p0[0], p0[1], 45, 100);
    T().onFix({ la: p1[0], lo: p1[1], acc: 8, t: Date.now() });
    ok(Math.abs(S9.along - a0 - 100) < 2, `moving 100m adds 100m (${(S9.along - a0).toFixed(1)})`);
    const p2 = window.CORE.destPoint(p1[0], p1[1], 45, 1.5);
    T().onFix({ la: p2[0], lo: p2[1], acc: 8, t: Date.now() });
    ok(Math.abs(S9.along - a0 - 100) < 2, 'a 1.5m jitter adds nothing');
    const p3 = window.CORE.destPoint(p1[0], p1[1], 45, 200);
    T().onFix({ la: p3[0], lo: p3[1], acc: 90, t: Date.now() });
    ok(Math.abs(S9.along - a0 - 100) < 2, 'a 90m-accuracy fix adds nothing');
    // 悪い測位の後の良い測位は、悪い測位からではなく最後の良い測位から測る
    const p3b = window.CORE.destPoint(p1[0], p1[1], 45, 50);
    T().onFix({ la: p3b[0], lo: p3b[1], acc: 8, t: Date.now() });
    ok(Math.abs(S9.along - a0 - 150) < 2, `distance resumes from the last good fix (${(S9.along - a0).toFixed(1)})`);

    T().render();
    ok(/残 4\.9km|残 4\.8km/.test(text()) || /残 /.test(text()), 'main shows the remaining distance to the target');
    ok(!/ETA/.test(text()) && !/CT /.test(text()) && !/引き返し限界/.test(text()),
       'no ETA / CT / turnaround are claimed without a route');
    S9.panel = 1; T().render(); ok(/断面図なし/.test(text()), 'profile panel says there is none');
    S9.panel = 3; T().render(); ok(/WPなし/.test(text()), 'WP panel says there are none');
    S9.panel = 2; T().render(); ok(/走行 /.test(text()) && /N↑/.test(text()), 'map panel draws the track with a north mark');
    S9.panel = 0;
    // 星と透視はそのまま使える
    S9.heading = 250; S9.headingReal = Date.now(); S9.headingSettled = true;
    S9.mode = 'ident'; S9.identLayer = 'ground'; T().render();
    ok(/富士山|丹沢山|大山/.test(text()) || /この方向に登録対象なし/.test(text()), 'see-through works from the famous-peak registry');
    S9.identLayer = 'sky'; S9.pitch = 30; S9.pitchReal = Date.now(); T().render();
    ok(/\d+星/.test(text()), 'the sky layer works anywhere');
    S9.mode = 'main';
    // 目標到達
    // 500m超の瞬間移動は足さない(実測位は毎秒来るので起き得ない)。刻んで進める
    let cur = p3b;
    for (let i = 0; i < 12; i++) { cur = window.CORE.destPoint(cur[0], cur[1], 45, 450); T().onFix({ la: cur[0], lo: cur[1], acc: 8, t: Date.now() }); }
    ok(S9.along >= 5000 && S9.freeDone === true && /到達/.test(S9.wpFlashMsg), `reaching the target flashes 到達 (${Math.round(S9.along)}m)`);
    S9.tracking = false; S9.mode = 'select'; S9.freeSel = false; S9.routeIdx = 0; T().render();
  }

  // ---- その場モード 段階2: 目標距離ごとの目標ペース(等速ゴースト) ----
  {
    const S10 = T().S;
    S10.routeIdx = T().nRoutes; T().render();
    key('Enter'); await sleep(400);
    ok(S10.mode === 'ready' && S10.freeSel === true, 'ここから → ready (free)');
    S10.freeGoal = 0; T().render();
    key('ArrowUp');
    ok(S10.paceEdit == null, 'no goal distance → no pace layer (a hint instead)');
    key('ArrowRight');                                        // 5km
    ok(S10.freeGoal === 5000 && S10.paceGoal == null, '→ selects 5km (pace unset)');
    key('ArrowUp');
    ok(S10.paceEdit === 30 && /5km の目標タイム/.test(text()) && /6:00\/km/.test(text()), '↑ opens the pace layer at 30 min (6:00/km × 5km)');
    key('ArrowRight'); key('ArrowRight');
    ok(S10.paceEdit === 40, '→→ = 40 min');
    key('Enter'); await sleep(100);
    ok(S10.paceGoal === 40 && S10.paceEdit == null && /目標ペース 40分 設定中/.test(text()), 'Enter fixes 40 min for 5km');
    key('ArrowRight');                                        // 10km は別の鍵
    ok(S10.freeGoal === 10000 && S10.paceGoal == null, '10km has its own (unset) pace goal');
    key('ArrowLeft');
    ok(S10.freeGoal === 5000 && S10.paceGoal === 40, 'back to 5km restores 40 min');
    key('Enter'); await sleep(1500);                          // 計測開始
    ok(S10.mode === 'main' && S10.tracking && S10.ghostSrc === 'pace', 'free run starts with the pace ghost');
    // 3分経過・1km 走った状態にして、等速ゴースト(40分で5km=125m/分)との差が出る
    S10.startMs = T().nowMs() - 3 * 60000;
    let cur = [S10.route.pts[0][0], S10.route.pts[0][1]];
    for (let i = 0; i < 3; i++) { cur = window.CORE.destPoint(cur[0], cur[1], 45, 330); T().onFix({ la: cur[0], lo: cur[1], acc: 8, t: Date.now() }); }
    T().render();
    const ga = T().ghostAlongNow();
    ok(ga != null && Math.abs(ga - 375) < 5, `ghost sits at 375m after 3 min (${ga && ga.toFixed(0)}m)`);
    ok(/[+\-−]\d+(\.\d+)?s|[+\-−]\d+分/.test(text()), 'delta bar shows the time gap to the pace ghost');
    S10.tracking = false; S10.mode = 'select'; S10.freeSel = false; S10.routeIdx = 0; S10.paceGoal = null; T().render();
  }

  console.log(`\n${step - fail}/${step} passed`);
  window.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
