'use strict';
const fs = require('fs');
const path = require('path');
const CORE = require('../src/core.js');

// routes.js は "var ROUTES = ..." 形式なので eval で読む
const routesSrc = fs.readFileSync(path.join(__dirname, '../src/routes.js'), 'utf8');
const ROUTES = eval(routesSrc + '; ROUTES');

let fail = 0, count = 0;
function ok(cond, msg) {
  count++;
  if (!cond) { fail++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ` (${a} vs ${b}, tol ${tol})`); }

/* 1. polyline roundtrip (python encoder → js decoder) */
console.log('[polyline]');
{
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
  const dec = CORE.decodePoly(fx.poly);
  const ele = CORE.decodeEle(fx.epoly);
  ok(dec.length === fx.pts.length, 'point count');
  let maxE = 0;
  for (let i = 0; i < dec.length; i++) {
    maxE = Math.max(maxE, Math.abs(dec[i][0] - fx.pts[i][0]), Math.abs(dec[i][1] - fx.pts[i][1]));
  }
  ok(maxE < 1.01e-5, 'coord roundtrip < 1e-5 deg (max ' + maxE.toExponential(2) + ')');
  let maxEle = 0;
  for (let i = 0; i < ele.length; i++) maxEle = Math.max(maxEle, Math.abs(ele[i] - fx.ele[i]));
  ok(maxEle <= 0.51, 'ele roundtrip <= 0.5m');
}

/* 2. route build sanity */
console.log('[routes]');
const built = ROUTES.map(CORE.buildRoute);
for (const r of built) {
  near(r.total, ROUTES.find(x => x.id === r.id).dist, r.total * 0.01 + 5, r.id + ' total dist matches header');
  const rem0 = CORE.remaining(r, 0);
  near(rem0.dist, r.total, 1, r.id + ' remaining at start = total');
  near(rem0.gain, r.gainTotal, 1, r.id + ' remaining gain at start = gainTotal');
  const remEnd = CORE.remaining(r, r.total);
  near(remEnd.dist, 0, 1, r.id + ' remaining at end = 0');
  ok(r.cts && r.ctTotal >= 25, r.id + ' has CT profile (' + r.ctTotal + 'min)');
}

/* 3. 単調マッチング: ピストン(デモB)で復路の点が復路に射影される */
console.log('[matching]');
{
  const B = built.find(r => r.id === 'takao');
  const half = B.total / 2;
  // 復路の途中(全体の72%)の実座標を取り、少し横にずらす
  const p = CORE.routePointAt(B, B.total * 0.72);
  const off = CORE.destPoint(p.la, p.lo, 90, 12); // 12m横
  // cursor が復路側にある場合 → 復路に張り付く
  const mRet = CORE.matchLocal(B, p.seg, off[0], off[1]);
  ok(mRet.along > half, 'return-leg point stays on return leg (along=' + Math.round(mRet.along) + ' > ' + Math.round(half) + ')');
  ok(mRet.dist < 40, 'projection distance small on-trail (' + mRet.dist.toFixed(1) + 'm)');
  // 同じ座標でも cursor が往路側なら往路に射影される(=カーソル依存が効いている)
  const pOut = CORE.routePointAt(B, B.total * 0.28);
  const mOut = CORE.matchLocal(B, pOut.seg, off[0], off[1]);
  ok(mOut.along < half + 200, 'outbound cursor projects to outbound leg (along=' + Math.round(mOut.along) + ')');
  // 初回(グローバル)射影が動く
  const g = CORE.matchLocal(B, null, off[0], off[1]);
  ok(g && g.dist < 40, 'global initial projection works');
}

/* 3b. ピストン全区間トラバース: 折り返しを跨いでも along が追従する */
{
  const B = built.find(r => r.id === 'takao');
  let cursor = null, prevAlong = 0, maxErr = 0, monoViol = 0, lastAlong = -1;
  for (let s = 0; s <= B.total; s += 12) {
    const p = CORE.routePointAt(B, s);
    // 6m程度の横ノイズ
    const off = CORE.destPoint(p.la, p.lo, (s * 37) % 360, 6);
    const m = CORE.matchLocal(B, cursor, off[0], off[1], prevAlong);
    cursor = m.seg; prevAlong = m.along;
    maxErr = Math.max(maxErr, Math.abs(m.along - s));
    if (m.along < lastAlong - 40) monoViol++;
    lastAlong = m.along;
  }
  ok(maxErr < 60, 'piston traverse: along tracks truth (maxErr ' + Math.round(maxErr) + 'm)');
  ok(monoViol === 0, 'piston traverse: no backward jumps > 40m (' + monoViol + ')');
  // ループ(デモA)の自己接近でも追従する
  const A = built.find(r => r.id === 'harumi');
  cursor = null; prevAlong = 0; maxErr = 0;
  for (let s = 0; s <= A.total; s += 12) {
    const p = CORE.routePointAt(A, s);
    const off = CORE.destPoint(p.la, p.lo, (s * 53) % 360, 6);
    const m = CORE.matchLocal(A, cursor, off[0], off[1], prevAlong);
    cursor = m.seg; prevAlong = m.along;
    maxErr = Math.max(maxErr, Math.abs(m.along - s));
  }
  ok(maxErr < 60, 'loop traverse: along tracks truth (maxErr ' + Math.round(maxErr) + 'm)');
}

/* 3c. 周回の原点付け替え(rotateLoop) */
console.log('[rotateLoop]');
{
  const K = built.find(r => r.id === 'kokyo');
  ok(CORE.isLoop(K), 'kokyo is a loop');
  const take = K.wps.find(w => w.n === '竹橋');
  const R = CORE.rotateLoop(K, take.d, take.n);
  near(R.total, K.total, 5, 'rotated total preserved');
  near(R.gainTotal, K.gainTotal, 3, 'rotated gain preserved');
  near(R.ctTotal, K.ctTotal, 0.5, 'rotated CT total preserved');
  ok(R.wps[0].n === '竹橋' && R.wps[0].d === 0, 'new start = 竹橋 at d=0');
  const hz = K.wps.find(w => w.n === '半蔵門');
  const hzR = R.wps.find(w => w.n === '半蔵門');
  near(hzR.d, (hz.d - take.d + K.total) % K.total, 30, '半蔵門 remapped correctly');
  // 回転後の起点座標 = 旧竹橋座標
  const tp = CORE.routePointAt(K, take.d);
  ok(CORE.hav(R.pts[0], [tp.la, tp.lo]) < 20, 'rotated origin at 竹橋 position');
  // 残距離: 竹橋の少し先に立つと ≈ total - ε
  const p = CORE.routePointAt(R, 150);
  const m = CORE.matchLocal(R, null, p.la, p.lo, 0);
  near(CORE.remaining(R, m.along).dist, R.total - 150, 40, 'fresh lap remaining from new origin');
  // CT単調性
  let mono = true;
  for (let i = 1; i < R.cts.length; i++) if (R.cts[i][1] < R.cts[i-1][1] - 0.01) mono = false;
  ok(mono, 'rotated CT profile monotonic');
  // 非ループには無効
  const F = built.find(r => r.id === 'fuji');
  ok(CORE.rotateLoop(F, 1000, 'x') === F, 'non-loop returns unchanged');
}

/* 4. 逸脱FSM */
console.log('[deviation fsm]');
{
  const f = CORE.createDevFSM({});
  f.step(60, 10); f.step(62, 10);
  ok(!f.state.deviated, 'not deviated after 2 hits');
  f.step(58, 10);
  ok(f.state.deviated, 'deviated after 3 consecutive >50m');
  f.step(40, 10);
  ok(f.state.deviated, 'hysteresis: 40m keeps deviated');
  f.step(30, 10);
  ok(!f.state.deviated, 'clears below 35m');
  // 低精度は無視
  const f2 = CORE.createDevFSM({});
  f2.step(60, 10); f2.step(60, 10); f2.step(300, 120); // acc 120m → 無視
  ok(!f2.state.deviated, 'low-accuracy fix ignored (no 3rd count)');
  f2.step(60, 10);
  ok(f2.state.deviated, 'counter survives ignored fix');
  // 一瞬の近接でカウンタリセット
  const f3 = CORE.createDevFSM({});
  f3.step(60, 10); f3.step(20, 10); f3.step(60, 10); f3.step(60, 10);
  ok(!f3.state.deviated, 'counter resets when back inside');
}

/* 5. 日没 (NOAA) — 既知値との突き合わせ */
console.log('[sunset]');
{
  const tokyo = { la: 35.6762, lo: 139.6503 };
  // 2024-06-21 東京 日没 19:00 JST = 10:00 UTC
  let s = CORE.sunTimes(tokyo.la, tokyo.lo, new Date(Date.UTC(2024, 5, 21, 0, 0)));
  let m = s.sunset.getUTCHours() * 60 + s.sunset.getUTCMinutes();
  near(m, 10 * 60 + 0, 3, 'Tokyo summer solstice sunset ~19:00 JST');
  // 2024-12-21 東京 日没 16:32 JST = 07:32 UTC
  s = CORE.sunTimes(tokyo.la, tokyo.lo, new Date(Date.UTC(2024, 11, 21, 0, 0)));
  m = s.sunset.getUTCHours() * 60 + s.sunset.getUTCMinutes();
  near(m, 7 * 60 + 32, 3, 'Tokyo winter solstice sunset ~16:32 JST');
  // 日の出も
  s = CORE.sunTimes(tokyo.la, tokyo.lo, new Date(Date.UTC(2024, 5, 21, 0, 0)));
  m = s.sunrise.getUTCHours() * 60 + s.sunrise.getUTCMinutes();
  near(m, (4 * 60 + 25) - 9 * 60 + 24 * 60, 4, 'Tokyo summer solstice sunrise ~4:25 JST'); // 19:25 UTC 前日
}

/* 6. ETA */
console.log('[eta]');
{
  const C = built.find(r => r.id === 'fuji');
  const along = C.total * 0.4;
  const ctDone = CORE.ctAt(C, along);
  // 標準CTの1.1倍で歩いている
  const eta = CORE.etaRemainMin(C, along, ctDone * 1.1, 3.0);
  ok(eta.method === 'ct', 'CT-ratio method selected');
  near(eta.min, (C.ctTotal - ctDone) * 1.1, 1, 'remaining = remainingCT × ratio');
  // CTなしルート相当: ペースにフォールバック
  const noCt = Object.assign({}, C, { cts: null, ctTotal: null });
  const eta2 = CORE.etaRemainMin(noCt, along, 100, 2.0);
  ok(eta2.method === 'pace', 'falls back to pace without CT');
  near(eta2.min, (C.total - along) / 1000 / 2.0 * 60, 1, 'pace math');
  // 序盤はCT比を使わない(比が不安定)
  const eta3 = CORE.etaRemainMin(C, 200, 3, 3.0);
  ok(eta3.method !== 'ct', 'no CT-ratio in first 400m');
}

/* 7. bearing / destPoint */
console.log('[geodesy]');
{
  near(CORE.bearing([36, 137], [37, 137]), 0, 0.5, 'bearing north = 0');
  near(CORE.bearing([36, 137], [36, 138]), 90, 0.5, 'bearing east = 90');
  const d = CORE.destPoint(36.5, 137.5, 45, 1000);
  near(CORE.hav([36.5, 137.5], d), 1000, 1, 'destPoint distance roundtrip');
  near(CORE.bearing([36.5, 137.5], d), 45, 0.5, 'destPoint bearing roundtrip');
}

/* 8. 書式 */
console.log('[format]');
{
  ok(CORE.fmtKm(2140) === '2.1km', 'fmtKm km');
  ok(CORE.fmtKm(850) === '850m', 'fmtKm m');
  ok(CORE.fmtDur(217) === '3:37', 'fmtDur h:mm');
  ok(CORE.fmtDiff(12.4) === '+12分', 'fmtDiff plus');
  ok(CORE.fmtDiff(-5) === '−5分', 'fmtDiff minus');
}

/* 9. DEM(地理院 標高タイル)デコードと等高線 */
console.log('[dem]');
{
  // 仕様: x = R*65536+G*256+B / x<2^23 → x*0.01 / x=2^23 → 無効 / x>2^23 → (x-2^24)*0.01
  ok(CORE.demElev(0, 0, 0) === 0, 'demElev zero');
  near(CORE.demElev(0, 1, 0), 2.56, 1e-9, 'demElev 256 → 2.56m');
  near(CORE.demElev(0, 0x2a, 0xf8), 110, 1e-9, 'demElev typical elevation (42*256+248 = 11000 → 110.00m)');
  ok(CORE.demElev(128, 0, 0) === null, 'demElev invalid marker (128,0,0) → null');
  ok(CORE.demElev(127, 255, 255) !== null, 'demElev just below 2^23 is valid');
  near(CORE.demElev(255, 255, 255), -0.01, 1e-9, 'demElev x>2^23 → negative');
  near(CORE.demElev(128, 0, 1), -83886.07, 1e-6, 'demElev just above 2^23 wraps negative');

  ok(CORE.contourStep(4) === 1, 'contourStep flat → 1m');
  ok(CORE.contourStep(300) === 10, 'contourStep 300m range → 10m');
  ok(CORE.contourStep(1500) === 50, 'contourStep alpine range → 50m');
  ok(CORE.contourStep(2000) / 1 >= 50, 'contourStep keeps line count bounded');
  {
    let worst = 0;
    for (const r of [0.5, 3, 17, 80, 240, 900, 3776, 20000]) worst = Math.max(worst, r / CORE.contourStep(r));
    ok(worst <= 40, 'contourStep never yields more than 40 lines');
  }

  // marching squares: 4x4 の東向き一様傾斜(値=x)。level=1.5 は縦一線で、全線分が x=1.5 上に乗る
  {
    const w = 4, h = 4, g = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x;
    const s = CORE.marchingSquares(g, w, h, 1.5);
    ok(s.length === (h - 1) * 4, 'ramp: one segment per cell row');
    let onLine = true;
    for (let i = 0; i < s.length; i += 4) if (Math.abs(s[i] - 1.5) > 1e-9 || Math.abs(s[i + 2] - 1.5) > 1e-9) onLine = false;
    ok(onLine, 'ramp: contour sits exactly on the interpolated level');
    ok(CORE.marchingSquares(g, w, h, 9).length === 0, 'level above max → no segments');
    ok(CORE.marchingSquares(g, w, h, -1).length === 0, 'level below min → no segments');
  }
  // 無効(null)を含むセルは線を作らない — 欠損域に嘘の等高線を引かないこと(正直さゲート)
  {
    const w = 3, h = 3, g = [0, 5, 0, 5, null, 5, 0, 5, 0];
    ok(CORE.marchingSquares(g, w, h, 2.5).length === 0, 'cells touching invalid DEM produce no contour');
  }
  // 鞍点(case 5/10)は中央値で結び方を決め、2本の線分を返す
  {
    const g = [0, 10, 10, 0];   // TL=0 TR=10 BL=10 BR=0 → case 5 相当
    ok(CORE.marchingSquares(g, 2, 2, 5).length === 8, 'saddle yields two segments');
  }
}

/* 10. 地図パネル用ベクタ(v3.2 優先2) */
console.log('[vec]');
{
  const line = (pts) => {                       // テスト用に polyline を作る
    let out = '', pla = 0, plo = 0;
    const enc = (v) => { v = v < 0 ? ~(v << 1) : (v << 1); let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63); };
    for (const [la, lo] of pts) {
      const a2 = Math.round(la * 1e5), b2 = Math.round(lo * 1e5);
      out += enc(a2 - pla) + enc(b2 - plo); pla = a2; plo = b2;
    }
    return out;
  };
  const poly = line([[35.0, 139.0], [35.001, 139.002]]);
  const base = { id: 'v', name: 'V', poly: poly, ele: CORE.decodeEle ? '??' : '??' };

  const r0 = CORE.buildRoute({ id: 'a', name: 'A', poly: poly, ele: '??' });
  ok(r0.vec === null, 'route without vec decodes to null (not an empty object)');

  const r1 = CORE.buildRoute({ id: 'b', name: 'B', poly: poly, ele: '??', domain: 'urban',
    vec: { road: [[4, poly], [1, poly]], rail: [[2, poly]], water: [[1, poly]] } });
  ok(r1.vec && r1.vec.road.length === 2 && r1.vec.rail.length === 1 && r1.vec.water.length === 1,
     'vec groups survive buildRoute');
  ok(r1.vec.road[0][0] === 4, 'road class is kept alongside the geometry');
  near(r1.vec.road[0][1][0][0], 35.0, 1e-6, 'vec polyline decodes to lat/lon');
  near(r1.vec.road[0][1][1][1], 139.002, 1e-6, 'vec polyline second point decodes');
  ok(r1.vec.road[0][1].length === 2, 'vec polyline keeps every point');

  const empty = CORE.buildRoute({ id: 'c', name: 'C', poly: poly, ele: '??', vec: { road: [] } });
  ok(empty.vec === null, 'a vec with no usable line decodes to null');
}

/* 11. 星表(v3.2 優先3) — 等級カット例外が効いているか */
console.log('[stars]');
{
  const starsSrc = fs.readFileSync(path.join(__dirname, '../src/stars.js'), 'utf8');
  const STARS = eval(starsSrc + '; STARS');
  const K = CORE.buildStars(STARS);
  const NS = K.s.length, NV = K.v.length;

  ok(NS > 0, `label-tier stars decoded (${NS})`);
  ok(Object.keys(K.c).length > 0, `constellations decoded (${Object.keys(K.c).length})`);

  let badRa = 0, badDec = 0, badMag = 0;
  for (const [, ra, dec, mag] of K.s) {
    if (!(ra >= 0 && ra < 24)) badRa++;
    if (!(dec >= -90 && dec <= 90)) badDec++;
    if (!(mag > -30 && mag < 20)) badMag++;
  }
  for (const [ra, dec, mag] of K.v) {
    if (!(ra >= 0 && ra < 24)) badRa++;
    if (!(dec >= -90 && dec <= 90)) badDec++;
    if (!(mag > -30 && mag < 20)) badMag++;
  }
  ok(badRa === 0 && badDec === 0 && badMag === 0, 'every decoded star has sane RA / Dec / magnitude');

  // 線の添字は s.concat(v) の連結空間に収まっていること。溢れたら線が消える
  let total = 0, refsVertex = 0, outOfRange = 0;
  for (const k of Object.keys(K.c)) {
    for (const [a2, b2] of K.c[k].l) {
      total++;
      if (a2 >= NS + NV || b2 >= NS + NV || a2 < 0 || b2 < 0) outOfRange++;
      if (a2 >= NS || b2 >= NS) refsVertex++;
    }
  }
  ok(outOfRange === 0, 'every constellation-line index resolves inside s.concat(v)');
  ok(total > 0, `constellation lines decoded (${total})`);

  // 精選版(v が空)なら 0、外部星表を入れたら大半が頂点専用を参照するはず
  if (NV > 0) {
    ok(refsVertex > total * 0.5,
       `most lines need the below-cut vertex stars (${refsVertex}/${total} = ${Math.round(100 * refsVertex / total)}%)`);
    ok(K.v.every(v => v.length === 3), 'vertex-only rows carry no name (geometry only)');
  } else {
    ok(refsVertex === 0, 'curated table needs no vertex-only stars');
    ok(true, 'skip: no vertex tier in the curated table');
  }

  // 名前はラベル用にしか付かない
  ok(K.s.some(x => x[0]), 'at least some label-tier stars carry a name');

  ok(CORE.buildStars(null).s.length === 0, 'buildStars(null) degrades to an empty sky');
  ok(CORE.buildStars({}).s.length === 0, 'buildStars({}) degrades to an empty sky');
}

console.log(`\n${count - fail}/${count} passed`);
process.exit(fail ? 1 : 0);
