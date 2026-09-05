/* ============================================================
 * core.js — 登山HUD 純ロジック層 (DOM依存なし / nodeでテスト可)
 * ============================================================ */
var CORE = (function () {
  'use strict';
  var R = 6371000;
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  /* ---------- polyline ---------- */
  function decodeDeltas(str) {
    var out = [], i = 0, v = 0, shift = 0;
    while (i < str.length) {
      var b = str.charCodeAt(i++) - 63;
      v |= (b & 0x1f) << shift; shift += 5;
      if (b < 0x20) {
        out.push((v & 1) ? ~(v >> 1) : (v >> 1));
        v = 0; shift = 0;
      }
    }
    return out;
  }
  function decodePoly(str) {
    var d = decodeDeltas(str), pts = [], la = 0, lo = 0;
    for (var i = 0; i + 1 < d.length; i += 2) {
      la += d[i]; lo += d[i + 1];
      pts.push([la / 1e5, lo / 1e5]);
    }
    return pts;
  }
  function decodeEle(str) {
    var d = decodeDeltas(str), out = [], e = 0;
    for (var i = 0; i < d.length; i++) { e += d[i]; out.push(e); }
    return out;
  }

  /* ---------- 測地 ---------- */
  function hav(a, b) { // [la,lo] m
    var la1 = a[0] * D2R, la2 = b[0] * D2R;
    var dla = (b[0] - a[0]) * D2R, dlo = (b[1] - a[1]) * D2R;
    var h = Math.sin(dla / 2) * Math.sin(dla / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) { // 真北基準 0-360
    var la1 = a[0] * D2R, la2 = b[0] * D2R, dlo = (b[1] - a[1]) * D2R;
    var y = Math.sin(dlo) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
    return (Math.atan2(y, x) * R2D + 360) % 360;
  }
  function destPoint(la, lo, brg, distM) { // sim用
    var d = distM / R, t = brg * D2R, f1 = la * D2R, l1 = lo * D2R;
    var f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
    var l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1),
                             Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return [f2 * R2D, ((l2 * R2D) + 540) % 360 - 180];
  }

  /* ---------- ルート構築 ---------- */
  function buildRoute(r) {
    var ll = decodePoly(r.poly), el = decodeEle(r.ele);
    var pts = [], cum = [0], gcum = [0];
    for (var i = 0; i < ll.length; i++) pts.push([ll[i][0], ll[i][1], el[i] || 0]);
    for (i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
      var de = pts[i][2] - pts[i - 1][2];
      gcum.push(gcum[i - 1] + (de > 0 ? de : 0));
    }
    return {
      id: r.id, name: r.name, demo: !!r.demo,
      pts: pts, cum: cum, gcum: gcum,
      total: cum[cum.length - 1], gainTotal: gcum[gcum.length - 1],
      wps: r.wps || [], cts: r.cts || null,
      ctTotal: r.cts ? r.cts[r.cts.length - 1][1] : null,
      reg: r.reg || [], dec: r.dec || 7.5, domain: r.domain || 'mountain', segs: r.segs || [],
      vec: decodeVec(r.vec)
    };
  }
  /* ---------- 引き返し限界(SPEC C-1) ---------- */
  // 標準式: 登り 300m/h + 水平 4km/h / 下り 500m/h + 水平 4.5km/h
  function legMin(dd, de) {
    return de >= 0 ? (dd / 4000 + de / 300) * 60 : (dd / 4500 + (-de) / 500) * 60;
  }
  function elevAt(route, s) {
    var c = route.cum, p = route.pts;
    if (s <= 0) return p[0][2];
    if (s >= c[c.length - 1]) return p[p.length - 1][2];
    var i = 1;
    while (i < c.length - 1 && c[i] < s) i++;
    var span = c[i] - c[i - 1];
    var f = span > 0 ? (s - c[i - 1]) / span : 0;
    return p[i - 1][2] + (p[i][2] - p[i - 1][2]) * f;
  }
  // from→to の標準CT(分)。to<from なら後退で、各区間の標高差の符号が反転する
  function ctBetween(route, from, to) {
    if (!route || from === to) return 0;
    var fwd = to > from, lo = Math.min(from, to), hi = Math.max(from, to);
    var c = route.cum, p = route.pts, t = 0;
    var s0 = lo, e0 = elevAt(route, lo);
    for (var i = 0; i < c.length; i++) {
      if (c[i] <= lo) continue;
      var s1 = Math.min(c[i], hi);
      var e1 = (s1 === c[i]) ? p[i][2] : elevAt(route, s1);
      if (s1 > s0) t += legMin(s1 - s0, fwd ? (e1 - e0) : (e0 - e1));
      s0 = s1; e0 = e1;
      if (s1 >= hi) break;
    }
    return t;
  }
  // 現在地から最寄りの安全終点(起点 or ゴール)までの標準CT
  function returnCT(route, along) {
    var toStart = ctBetween(route, along, 0);
    var toGoal = ctBetween(route, along, route.total);
    var viaStart = toStart <= toGoal;
    return { toStart: toStart, toGoal: toGoal,
             min: viaStart ? toStart : toGoal, via: viaStart ? 'start' : 'goal' };
  }
  // 引き返し限界時刻 = 日没 − マージン − 復路CT。日没や現在地が無ければ null(出さない)
  function turnaroundLimit(route, along, sunsetMs, marginMin, nowMs) {
    if (!route || along == null || !sunsetMs) return null;
    var r = returnCT(route, along);
    var at = sunsetMs - (marginMin || 0) * 60000 - r.min * 60000;
    return { at: at, remainMin: (at - nowMs) / 60000, ct: r.min, via: r.via };
  }

  /* ---------- ゴーストとの時間差(SPEC C-2) ---------- */
  // ゴーストがその沿道位置を通過した経過秒。samples は [経過秒, along] の昇順列
  function ghostTimeAt(src, along, opt) {
    opt = opt || {};
    if (src === 'ct') {
      var m = ctAt(opt.route, along);
      return m == null ? null : m * 60;
    }
    if (src === 'pace') {
      if (!opt.paceGoal || !opt.route || !opt.route.total) return null;
      return opt.paceGoal * 60 * (along / opt.route.total);
    }
    var ss = opt.samples;
    if (!ss || ss.length < 2) return null;
    if (along <= ss[0][1]) return ss[0][0];
    for (var i = 1; i < ss.length; i++) {
      if (ss[i][1] >= along) {
        var d = ss[i][1] - ss[i - 1][1];
        var f = d > 0 ? (along - ss[i - 1][1]) / d : 0;
        return ss[i - 1][0] + (ss[i][0] - ss[i - 1][0]) * f;
      }
    }
    return null;                                  // ゴーストがまだそこまで来ていない
  }
  // delta > 0 = 自分が速い(ゴーストは同じ地点をもっと後で通った)
  function ghostDelta(src, along, elapsedSec, opt) {
    var g = ghostTimeAt(src, along, opt);
    return g == null ? null : g - elapsedSec;
  }

  /* ---------- コース偏差の符号(SPEC C-9 の下ごしらえ) ---------- */
  // ルート進行方向に対して右にいれば +、左なら −
  function signedCrossTrack(route, along, la, lo) {
    if (!route) return null;
    var a = routePointAt(route, Math.max(0, along - 25));
    var b = routePointAt(route, Math.min(route.total, along + 25));
    var here = routePointAt(route, along);
    var brgRoute = bearing([a.la, a.lo], [b.la, b.lo]);
    var brgMe = bearing([here.la, here.lo], [la, lo]);
    var d = hav([here.la, here.lo], [la, lo]);
    var rel = angDiff(brgMe, brgRoute);
    return d * Math.sin(rel * D2R);
  }

  /* ---------- 勾配と次の登り(SPEC C-7) ---------- */
  // 直近 win(m) の標高差から現在勾配(%)
  function gradeAt(route, along, win) {
    win = win || 50;
    var a = Math.max(0, along - win), b = Math.min(route.total, along);
    if (b - a < 10) return null;
    return (elevAt(route, b) - elevAt(route, a)) / (b - a) * 100;
  }
  // この先で「勾配 minGrade% 以上が minLen m 以上続く区間」の最初のもの
  // → {startIn: 何m先, len: 区間長, avg: 平均勾配%, gain: 登り高} / 無ければ null
  function nextClimb(route, along, minGrade, minLen, step) {
    if (!route || along == null) return null;
    minGrade = minGrade || 8; minLen = minLen || 100; step = step || 25;
    var s = along, inRun = false, runStart = 0, runGain = 0, prevE = elevAt(route, along);
    for (s = along + step; s <= route.total; s += step) {
      var e = elevAt(route, s), g = (e - prevE) / step * 100;
      if (g >= minGrade) {
        if (!inRun) { inRun = true; runStart = s - step; runGain = 0; }
        runGain += (e - prevE);
      } else if (inRun) {
        var len = (s - step) - runStart;
        if (len >= minLen) return { startIn: runStart - along, len: len, avg: runGain / len * 100, gain: runGain };
        inRun = false;
      }
      prevE = e;
    }
    if (inRun) {
      var len2 = (s - step) - runStart;
      if (len2 >= minLen) return { startIn: runStart - along, len: len2, avg: runGain / len2 * 100, gain: runGain };
    }
    return null;
  }

  /* ---------- 実効速度 VMG(SPEC C-8) ---------- */
  // hist: [[ms, along], ...]。直近 winSec 秒の Δalong/Δt (m/s)。後戻り・停止は 0 以下になる
  function vmg(hist, nowMs, winSec) {
    winSec = winSec || 60;
    if (!hist || hist.length < 2) return null;
    var oldest = null;
    for (var i = 0; i < hist.length; i++) { if (nowMs - hist[i][0] <= winSec * 1000) { oldest = hist[i]; break; } }
    var newest = hist[hist.length - 1];
    if (!oldest || oldest === newest) return null;
    var dt = (newest[0] - oldest[0]) / 1000;
    if (dt < 10) return null;
    return (newest[1] - oldest[1]) / dt;
  }

  /* ---------- 日本域の磁気偏角の近似(その場モード用) ----------
     ルートには gpx2route.py が WMM から焼き込むが、その場モードは事前計算が無い。
     WMM2025 を日本域(北緯24〜46°/東経123〜147°、2027.0)で格子サンプルし平面に最小二乗フィット。
     格子132点で最大残差1.01°・平均0.36°。主要都市は±0.3°以内(東京 7.76 vs WMM 7.93)。
     西偏を正で返す。日本の外では使わない(範囲外は 7.5 に丸める)。 */
  function decJapan(la, lo) {
    if (la < 24 || la > 46 || lo < 123 || lo > 147) return 7.5;
    return Math.round((5.68314 + 0.302020 * la - 0.062274 * lo) * 100) / 100;
  }

  /* ---------- 尾根線・谷線(SPEC A-2) ----------
     各セルで、横方向または縦方向に「両隣より prom 以上高い」なら尾根の背、低いなら谷底。
     検出セルを、その直交方向(=稜線の走る向き)へ隣のセルまで短い線分で結ぶ。
     隣接する検出が繋がって線になる。返り値は [x0,y0,x1,y1,...] のフラット配列。 */
  function ridgeValley(grid, w, h, prom) {
    var r = [], v = [];
    function at(x, y) { return grid[y * w + x]; }
    for (var y = 1; y + 1 < h; y++) {
      for (var x = 1; x + 1 < w; x++) {
        var c = at(x, y);
        if (c == null) continue;
        var l = at(x - 1, y), rt = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1);
        if (l == null || rt == null || u == null || d == null) continue;
        // 横断面で背: 稜線は縦に走る → 縦の隣へ結ぶ
        if (c - l >= prom && c - rt >= prom) r.push(x, y, x, y + 1);
        if (c - u >= prom && c - d >= prom) r.push(x, y, x + 1, y);
        if (l - c >= prom && rt - c >= prom) v.push(x, y, x, y + 1);
        if (u - c >= prom && d - c >= prom) v.push(x, y, x + 1, y);
      }
    }
    return { r: r, v: v };
  }

  /* 尾根線/谷線を「流域集積」で抜く(A-2 次段)。
     ridgeValley は1セルの背を閾値で拾うだけなので、DEMの量子化やグリッド刻みで背が1セルに
     収まらない稜線が全部落ちた(高尾山の実タイルで尾根52px)。ここでは D8 流下方向で
     集積面積を数え、一定以上のセルを下流へ結ぶ = 谷線。DEMを裏返して同じことをすると尾根線。
     線は流下方向に沿って自然に連結し、閾値がそのまま「細かさ」になる。
     minAcc: 線として出す最小集積セル数 */
  function ridgeValleyFlow(grid, w, h, minAcc) {
    var n = w * h, i;
    function flow(sign) {                                   // sign=+1: 谷(下る) / -1: 尾根(登る=裏返し)
      var down = new Int32Array(n), acc = new Float64Array(n), order = [];
      for (i = 0; i < n; i++) { down[i] = -1; if (grid[i] != null) { order.push(i); acc[i] = 1; } }
      for (i = 0; i < order.length; i++) {
        var c = order[i], x = c % w, y = (c - x) / w, hc = grid[c] * sign, best = 0, bj = -1;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            var j = yy * w + xx;
            if (grid[j] == null) continue;
            var s = (hc - grid[j] * sign) / ((dx && dy) ? 1.41421356 : 1);   // 落差/距離 = 勾配
            if (s > best) { best = s; bj = j; }
          }
        }
        down[c] = bj;
      }
      // 高い方から順に集積を下流へ流す(sign で「高い」の向きが変わる)
      order.sort(function (a, b) { return (grid[b] - grid[a]) * sign; });
      for (i = 0; i < order.length; i++) {
        var u = order[i], d = down[u];
        if (d >= 0) acc[d] += acc[u];
      }
      var segs = [];
      for (i = 0; i < n; i++) {
        var d2 = down[i];
        if (d2 < 0 || acc[i] < minAcc || acc[d2] < minAcc) continue;
        segs.push(i % w, (i - i % w) / w, d2 % w, (d2 - d2 % w) / w);
      }
      return segs;
    }
    return { v: flow(1), r: flow(-1) };
  }

  /* ---------- 星表(stars.js の圧縮形式)を展開する ----------
     s: ラベル用 [名前, RA時, Dec度, 等級] / v: 線の頂点専用 [RA時, Dec度, 等級]
     c: {略号: {n: 和名, l: [[i,j], ...]}} — 添字は s.concat(v) の連結空間。
     線が参照する星は等級カットの例外として v に入っている。v を落とすと線が欠ける。 */
  function buildStars(S) {
    if (!S || !S.p) return { s: [], v: [], c: {} };
    var pc = decodePoly(S.p), mg = decodeEle(S.m || ''), nm = S.nm || {};
    var s = [], v = [], i;
    for (i = 0; i < pc.length; i++) {
      var m = (mg[i] || 0) / 10;
      if (i < S.n) s.push([nm[i] || '', pc[i][0], pc[i][1], m]);
      else v.push([pc[i][0], pc[i][1], m]);
    }
    var c = {}, k;
    for (k in S.c) {
      if (!Object.prototype.hasOwnProperty.call(S.c, k)) continue;
      var f = decodeEle(S.c[k].l || ''), l = [];
      for (i = 0; i + 1 < f.length; i += 2) l.push([f[i], f[i + 1]]);
      c[k] = { n: S.c[k].n, l: l };
    }
    return { s: s, v: v, c: c };
  }

  // 地図パネル用ベクタ {road|rail|water: [[クラス, 圧縮poly], ...]} を一度だけ展開する
  function decodeVec(v) {
    if (!v) return null;
    var out = {}, any = false;
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      var g = [];
      for (var i = 0; i < v[k].length; i++) g.push([v[k][i][0], decodePoly(v[k][i][1])]);
      if (g.length) { out[k] = g; any = true; }
    }
    return any ? out : null;
  }

  /* ---------- 周回の原点付け替え ---------- */
  function isLoop(route) {
    return hav(route.pts[0], route.pts[route.pts.length - 1]) < 60;
  }
  // 周回ルートの原点を offAlong 地点へ回転する(竹橋スタートの皇居ラン等)。
  // 距離・獲得標高・CT合計は不変。wps は新しい沿道距離に写像される。
  function rotateLoop(route, offAlong, startName) {
    var total = route.total;
    if (!isLoop(route) || offAlong <= 1 || offAlong >= total - 1) return route;
    var pts = route.pts, cum = route.cum, n = pts.length;
    // 閉路の重複終端を除いた本体
    var dup = hav(pts[0], pts[n - 1]) < 5;
    var body = dup ? pts.slice(0, n - 1) : pts.slice();
    // 回転点(補間)
    var seg = 0;
    while (seg + 1 < cum.length && cum[seg + 1] < offAlong) seg++;
    var f = (offAlong - cum[seg]) / Math.max(cum[seg + 1] - cum[seg], 1e-9);
    var a = pts[seg], b = pts[Math.min(seg + 1, n - 1)];
    var p0 = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
    var np = [p0];
    for (var i = seg + 1; i < body.length; i++) np.push(body[i]);
    for (i = 0; i <= seg && i < body.length; i++) np.push(body[i]);
    np.push([p0[0], p0[1], p0[2]]);
    // プロファイル再構築
    var ncum = [0], ngcum = [0];
    for (i = 1; i < np.length; i++) {
      ncum.push(ncum[i - 1] + hav(np[i - 1], np[i]));
      var de = np[i][2] - np[i - 1][2];
      ngcum.push(ngcum[i - 1] + (de > 0 ? de : 0));
    }
    var ntotal = ncum[ncum.length - 1];
    // WP写像(旧start/goalの0/total点は除外して新しい起終点を与える)
    var nwps = [{ d: 0, n: startName || 'スタート', t: 'start' }];
    for (i = 0; i < route.wps.length; i++) {
      var w = route.wps[i];
      if (w.d <= 1 || w.d >= total - 1) continue;
      var nd = (w.d - offAlong + total) % total;
      if (nd <= 1 || nd >= ntotal - 1) continue;
      nwps.push({ d: Math.round(nd), n: w.n, t: w.t === 'start' || w.t === 'goal' ? 'wp' : w.t });
    }
    nwps.push({ d: Math.round(ntotal), n: 'ゴール (' + (startName || 'スタート') + ')', t: 'goal' });
    nwps.sort(function (x, y) { return x.d - y.d; });
    // CTプロファイル回転: ct'(d) = ct(d+off)-ct(off) (+周回補正)
    var ncts = null;
    if (route.cts) {
      var ctOff = interp(route.cts, offAlong, 0, 1);
      var ctTot = route.ctTotal;
      ncts = [[0, 0]];
      for (i = 0; i < route.cts.length; i++) {
        var cd = route.cts[i][0], cm = route.cts[i][1];
        if (cd <= 1 || cd >= total - 1) continue;
        var nd2 = (cd - offAlong + total) % total;
        var nm = cm - ctOff; if (nm < 0) nm += ctTot;
        if (nd2 > 1 && nd2 < ntotal - 1) ncts.push([Math.round(nd2), Math.round(nm * 10) / 10]);
      }
      ncts.push([Math.round(ntotal), Math.round(ctTot)]);
      ncts.sort(function (x, y) { return x[0] - y[0]; });
    }
    // 区間は回転写像(原点を跨ぐものは落とす: 跨ぎ分割は複雑さに見合わない)
    var nsegs = [];
    if (route.segs) {
      for (i = 0; i < route.segs.length; i++) {
        var sg = route.segs[i];
        var na2 = (sg.a - offAlong + total) % total, nb2 = (sg.b - offAlong + total) % total;
        if (na2 < nb2) nsegs.push({ a: Math.round(na2), b: Math.round(nb2), n: sg.n });
      }
    }
    return {
      id: route.id, name: route.name, demo: route.demo,
      pts: np, cum: ncum, gcum: ngcum,
      total: ntotal, gainTotal: ngcum[ngcum.length - 1],
      wps: nwps, cts: ncts, ctTotal: route.ctTotal, rotatedFrom: offAlong,
      reg: route.reg, dec: route.dec, domain: route.domain, segs: nsegs,
      vec: route.vec          // 地図の絵は起点をどこにしても同じもの(回転しない)
    };
  }

  /* ---------- 射影(マップマッチング) ---------- */
  // 局所平面近似で点—線分最近傍。戻り値 dist は m。
  function projSeg(p, a, b) {
    var k = Math.cos(a[0] * D2R);
    var px = (p[1] - a[1]) * k * 111320, py = (p[0] - a[0]) * 110540;
    var bx = (b[1] - a[1]) * k * 111320, by = (b[0] - a[0]) * 110540;
    var L2 = bx * bx + by * by, t = 0;
    if (L2 > 0) t = Math.max(0, Math.min(1, (px * bx + py * by) / L2));
    var dx = px - t * bx, dy = py - t * by;
    return { t: t, dist: Math.sqrt(dx * dx + dy * dy) };
  }
  // prevAlong があれば「進行の連続性」でスコアリング:
  //   後退は 0.03/m、前進は 0.005/m のペナルティ。
  // 往路復路が同一線形のピストンでは最近傍距離が同点になるため、
  // 折り返し後に往路へ張り付いたまま along が逆走するのを防ぐ。
  function projectRange(route, la, lo, i0, i1, prevAlong) {
    var p = [la, lo], best = null;
    i0 = Math.max(0, i0); i1 = Math.min(route.pts.length - 2, i1);
    for (var i = i0; i <= i1; i++) {
      var r = projSeg(p, route.pts[i], route.pts[i + 1]);
      var segLen = route.cum[i + 1] - route.cum[i];
      var along = route.cum[i] + segLen * r.t;
      var score = r.dist;
      if (prevAlong != null) {
        // 連続性: 1fix(1〜5秒)で進める距離は数十m。九十九折りで隣の脚が 7m 以内に寄ると、
        // 6m のGPSノイズだけで along が 90m 飛ぶ(高尾1号路の実ログで実測: 往復で5回)。
        // 30m までは軽く、それ以上の前進と後退は 0.1m/m(=90m 飛ぶには 6m 以上の近さが要る)
        var d = along - prevAlong;
        score += (d < 0) ? -d * 0.1 : (d <= 30 ? d * 0.005 : 0.15 + (d - 30) * 0.1);
      }
      if (!best || score < best.score) {
        best = { seg: i, t: r.t, dist: r.dist, along: along, score: score };
      }
    }
    return best;
  }
  // 単調マッチング: 前回セグメント(cursor)近傍を優先。ピストン/ループの
  // 復路・自己接近で反対側の脚に飛ぶのを防ぐ。少しの後戻り(-15)は許容。
  function matchLocal(route, cursor, la, lo, prevAlong) {
    if (cursor == null || cursor < 0) return projectRange(route, la, lo, 0, 1e9, prevAlong);
    var r = projectRange(route, la, lo, cursor - 15, cursor + 40, prevAlong);
    if (r && r.dist > 120) {
      var w = projectRange(route, la, lo, cursor - 60, cursor + 150, prevAlong);
      if (w && w.score < r.score) r = w;
    }
    return r;
  }

  /* ---------- 残距離・残標高(ルートプロファイル基準。GPS高度は使わない) ---------- */
  function interp(xs_ys, x, xi, yi) { // 単調xs前提
    var a = xs_ys, n = a.length;
    if (x <= a[0][xi]) return a[0][yi];
    for (var i = 1; i < n; i++) {
      if (x <= a[i][xi]) {
        var f = (x - a[i - 1][xi]) / Math.max(a[i][xi] - a[i - 1][xi], 1e-9);
        return a[i - 1][yi] + f * (a[i][yi] - a[i - 1][yi]);
      }
    }
    return a[n - 1][yi];
  }
  function gainAt(route, along) {
    var c = route.cum, g = route.gcum, n = c.length;
    if (along <= 0) return 0;
    for (var i = 1; i < n; i++) {
      if (along <= c[i]) {
        var f = (along - c[i - 1]) / Math.max(c[i] - c[i - 1], 1e-9);
        return g[i - 1] + f * (g[i] - g[i - 1]);
      }
    }
    return g[n - 1];
  }
  function remaining(route, along) {
    return {
      dist: Math.max(0, route.total - along),
      gain: Math.max(0, route.gainTotal - gainAt(route, along))
    };
  }
  function routePointAt(route, along) { // sim/矢印目標用
    var c = route.cum, p = route.pts, n = c.length;
    if (along <= 0) return { la: p[0][0], lo: p[0][1], seg: 0 };
    for (var i = 1; i < n; i++) {
      if (along <= c[i]) {
        var f = (along - c[i - 1]) / Math.max(c[i] - c[i - 1], 1e-9);
        return {
          la: p[i - 1][0] + f * (p[i][0] - p[i - 1][0]),
          lo: p[i - 1][1] + f * (p[i][1] - p[i - 1][1]),
          seg: i - 1
        };
      }
    }
    return { la: p[n - 1][0], lo: p[n - 1][1], seg: n - 2 };
  }

  /* ---------- CT・ETA ---------- */
  function ctAt(route, along) {
    if (!route.cts) return null;
    return interp(route.cts, along, 0, 1);
  }
  // ETA(残り分)。主: 残りCT×実績CT比 / 従: 実測ペース
  function etaRemainMin(route, along, elapsedMovingMin, emaKmh) {
    var rem = remaining(route, along);
    if (route.cts && along > 400 && elapsedMovingMin > 8) {
      var done = ctAt(route, along);
      if (done > 5) {
        var ratio = elapsedMovingMin / done;
        ratio = Math.max(0.4, Math.min(3, ratio));
        return { min: (route.ctTotal - done) * ratio, method: 'ct', ratio: ratio };
      }
    }
    if (emaKmh > 0.2) {
      return { min: (rem.dist / 1000) / emaKmh * 60, method: 'pace', ratio: null };
    }
    if (route.cts) {
      return { min: route.ctTotal - (ctAt(route, along) || 0), method: 'ct0', ratio: 1 };
    }
    return { min: null, method: 'none', ratio: null };
  }

  // CT累積分 → 沿道距離(標準CT歩行者=ゴーストの現在位置)
  function ctInverse(route, min) {
    if (!route.cts) return null;
    var a = route.cts;
    if (min <= a[0][1]) return a[0][0];
    for (var i = 1; i < a.length; i++) {
      if (min <= a[i][1]) {
        var f = (min - a[i - 1][1]) / Math.max(a[i][1] - a[i - 1][1], 1e-9);
        return a[i - 1][0] + f * (a[i][0] - a[i - 1][0]);
      }
    }
    return a[a.length - 1][0];
  }
  function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }   // 符号付き -180..180

  /* ---------- 日没 (NOAA式・オフライン) ---------- */
  function sunEventUTC(dateUTCms, lat, lng, rise) {
    // dateUTCms: その日の00:00UTC。戻り値: UTC分(その日基準)。極夜/白夜はnull
    function calc(tMin) {
      var d = new Date(dateUTCms);
      var start = Date.UTC(d.getUTCFullYear(), 0, 0);
      var doy = (dateUTCms - start) / 86400000;
      var g = 2 * Math.PI / 365 * (doy - 1 + (tMin / 60 - 12) / 24);
      var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
              - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
      var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
               - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
               - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
      var latR = lat * D2R;
      var cosHA = Math.cos(90.833 * D2R) / (Math.cos(latR) * Math.cos(decl))
                - Math.tan(latR) * Math.tan(decl);
      if (cosHA < -1 || cosHA > 1) return null;
      var ha = Math.acos(cosHA) * R2D;
      return 720 - 4 * (lng + (rise ? ha : -ha)) - eq;
    }
    var t = calc(720);
    if (t === null) return null;
    var t2 = calc(t);
    return (t2 === null) ? t : t2;
  }
  function sunTimes(lat, lng, now) {
    var day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    function mk(ms, rise) {
      var m = sunEventUTC(ms, lat, lng, rise);
      return m === null ? null : new Date(ms + m * 60000);
    }
    var set = mk(day, false);
    if (set && set.getTime() < now.getTime() - 6 * 3600000) set = mk(day + 86400000, false);
    return { sunrise: mk(day, true), sunset: set };
  }

  /* ---------- 逸脱FSM ---------- */
  // 判定: dist>trig が need回連続 → 逸脱 / dist<clear で解除(ヒステリシス)
  // accuracy>accMax の測位はカウントに使わない(進めも戻しもしない)
  function createDevFSM(o) {
    o = o || {};
    var trig = o.trig || 50, clear = o.clear || 35,
        need = o.need || 3, accMax = o.accMax || 75;
    var s = { deviated: false, cnt: 0, dist: 0 };
    return {
      state: s,
      step: function (dist, acc) {
        if (acc != null && acc > accMax) return s; // 低精度は無視
        s.dist = dist;
        if (!s.deviated) {
          if (dist > trig) { s.cnt++; if (s.cnt >= need) s.deviated = true; }
          else s.cnt = 0;
        } else if (dist < clear) {
          s.deviated = false; s.cnt = 0;
        }
        return s;
      },
      reset: function () { s.deviated = false; s.cnt = 0; s.dist = 0; }
    };
  }

  /* ---------- 表示整形 ---------- */
  function fmtKm(m) {
    if (m == null) return '--';
    return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm';
  }
  function fmtClock(d) {
    if (!d) return '--:--';
    var h = d.getHours(), m = d.getMinutes();
    return h + ':' + (m < 10 ? '0' : '') + m;
  }
  function fmtDur(min) {
    if (min == null) return '--';
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m : m + '分';
  }
  function fmtDiff(min) {
    if (min == null) return '--';
    var r = Math.round(min);
    return (r >= 0 ? '+' : '−') + Math.abs(r) + '分';
  }

  /* ---------- DEM(地理院 標高タイルPNG)と等高線 ---------- */
  // (R,G,B) → 標高m。x = R*65536+G*256+B / x<2^23: x*0.01 / x=2^23: 無効 / x>2^23: (x-2^24)*0.01
  // 無効値のピクセルは (128,0,0) すなわち x=2^23。nullを返す(0mと混同しないこと)
  function demElev(r, g, b) {
    var x = r * 65536 + g * 256 + b;
    if (x === 8388608) return null;
    return (x < 8388608 ? x : x - 16777216) * 0.01;
  }
  // 等高線間隔を選ぶ。レンジだけで決めると急斜面で線が数px間隔に潰れるので、
  // 画面上の勾配(m/px)を渡したときは「隣り合う線が minPx 以上離れる」ことを主条件にする。
  // gradPerPx 省略時はレンジのみ(線40本以内)。加算ディスプレイでは線の混み過ぎ=白い塊になる。
  function contourStep(range, gradPerPx, minPx) {
    var cand = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (var i = 0; i < cand.length; i++) {
      if (range / cand[i] > 40) continue;
      if (gradPerPx && cand[i] / gradPerPx < (minPx || 14)) continue;
      return cand[i];
    }
    return cand[cand.length - 1];
  }
  // グリッドの勾配(m/画面px)の分位点。急斜面側を見たいので既定は70%点
  function gradPercentile(grid, w, h, gridPx, p) {
    var v = [];
    for (var y = 1; y + 1 < h; y++) {
      for (var x = 1; x + 1 < w; x++) {
        var l = grid[y * w + x - 1], r = grid[y * w + x + 1];
        var u = grid[(y - 1) * w + x], d = grid[(y + 1) * w + x];
        if (l == null || r == null || u == null || d == null) continue;
        var gx = (r - l) / (2 * gridPx), gy = (d - u) / (2 * gridPx);
        v.push(Math.sqrt(gx * gx + gy * gy));
      }
    }
    if (!v.length) return 0;
    v.sort(function (a, b) { return a - b; });
    return v[Math.min(v.length - 1, Math.floor(v.length * (p == null ? 0.7 : p)))];
  }
  // marching squares。grid は行優先の配列で無効は null。返り値は [x0,y0,x1,y1,...] のフラット線分列
  function marchingSquares(grid, w, h, level) {
    var out = [];
    function mid(a, b) { return (level - a) / (b - a); }
    for (var y = 0; y + 1 < h; y++) {
      for (var x = 0; x + 1 < w; x++) {
        var tl = grid[y * w + x], tr = grid[y * w + x + 1];
        var bl = grid[(y + 1) * w + x], br = grid[(y + 1) * w + x + 1];
        if (tl == null || tr == null || bl == null || br == null) continue;
        var c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
        if (c === 0 || c === 15) continue;
        var T = [x + mid(tl, tr), y], Rt = [x + 1, y + mid(tr, br)],
            B = [x + mid(bl, br), y + 1], L = [x, y + mid(tl, bl)];
        var pairs;
        if (c === 5 || c === 10) {                      // 鞍点: 中央値で結び方を決める
          var up = ((tl + tr + bl + br) / 4) >= level;
          if (c === 5) pairs = up ? [[T, L], [B, Rt]] : [[T, Rt], [L, B]];
          else         pairs = up ? [[T, Rt], [L, B]] : [[T, L], [B, Rt]];
        } else if (c === 1 || c === 14) pairs = [[L, B]];
        else if (c === 2 || c === 13) pairs = [[B, Rt]];
        else if (c === 3 || c === 12) pairs = [[L, Rt]];
        else if (c === 4 || c === 11) pairs = [[T, Rt]];
        else if (c === 6 || c === 9)  pairs = [[T, B]];
        else                          pairs = [[T, L]];  // 7, 8
        for (var p = 0; p < pairs.length; p++) {
          out.push(pairs[p][0][0], pairs[p][0][1], pairs[p][1][0], pairs[p][1][1]);
        }
      }
    }
    return out;
  }

  return {
    decodePoly: decodePoly, decodeEle: decodeEle,
    ctBetween: ctBetween, returnCT: returnCT, turnaroundLimit: turnaroundLimit,
    gradeAt: gradeAt, nextClimb: nextClimb, vmg: vmg, decJapan: decJapan,
    ghostTimeAt: ghostTimeAt, ghostDelta: ghostDelta, signedCrossTrack: signedCrossTrack,
    buildStars: buildStars,
    demElev: demElev, contourStep: contourStep, gradPercentile: gradPercentile,
    marchingSquares: marchingSquares, ridgeValley: ridgeValley, ridgeValleyFlow: ridgeValleyFlow,
    hav: hav, bearing: bearing, destPoint: destPoint,
    buildRoute: buildRoute,
    projectRange: projectRange, matchLocal: matchLocal,
    remaining: remaining, gainAt: gainAt, routePointAt: routePointAt,
    ctAt: ctAt, ctInverse: ctInverse, angDiff: angDiff, etaRemainMin: etaRemainMin,
    sunTimes: sunTimes,
    createDevFSM: createDevFSM,
    isLoop: isLoop, rotateLoop: rotateLoop,
    fmtKm: fmtKm, fmtClock: fmtClock, fmtDur: fmtDur, fmtDiff: fmtDiff
  };
})();
if (typeof module !== 'undefined') module.exports = CORE;
