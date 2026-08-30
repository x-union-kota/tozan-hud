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
      reg: r.reg || [], dec: r.dec || 7.5, domain: r.domain || 'mountain', segs: r.segs || []
    };
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
      reg: route.reg, dec: route.dec, domain: route.domain, segs: nsegs
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
        var d = along - prevAlong;
        score += (d < 0) ? -d * 0.03 : d * 0.005;
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

  return {
    decodePoly: decodePoly, decodeEle: decodeEle,
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
