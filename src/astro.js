/* ============================================================
 * astro.js — 天文計算(ラベル用途 ±1°級 / オフライン完結)
 *  恒星: J2000 RA/Dec → 方位・仰角
 *  太陽: Meeus低精度式(±0.01°) / 月: 打ち切り級数(±0.5°)
 *  惑星: 平均ケプラー要素(JPL近似, 数十年で±1°級)
 * ============================================================ */
var ASTRO = (function () {
  'use strict';
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function norm(x) { x = x % 360; return x < 0 ? x + 360 : x; }
  function jd(ms) { return ms / 86400000 + 2440587.5; }

  function gmst(ms) {   // 度
    var d = jd(ms) - 2451545.0;
    return norm(280.46061837 + 360.98564736629 * d);
  }
  // RA(時)・Dec(度) → {alt, az}(度, azは真北0時計回り)
  function altAz(raH, dec, lat, lon, ms) {
    var lst = norm(gmst(ms) + lon);
    var H = (lst - raH * 15) * D2R;
    var f = lat * D2R, d = dec * D2R;
    var alt = Math.asin(Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(H));
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(f) - Math.tan(d) * Math.cos(f));
    return { alt: alt * R2D, az: norm(az * R2D + 180) };
  }
  function eclToEq(lam, bet, ms) {   // 黄経黄緯(度) → {ra時, dec度}
    var n = jd(ms) - 2451545.0;
    var eps = (23.439 - 0.0000004 * n) * D2R;
    var l = lam * D2R, b = bet * D2R;
    var ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l));
    var dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l));
    return { ra: norm(ra * R2D) / 15, dec: dec * R2D };
  }
  function sunEcl(ms) {   // 太陽の視黄経(度)
    var n = jd(ms) - 2451545.0;
    var L = norm(280.460 + 0.9856474 * n);
    var g = norm(357.528 + 0.9856003 * n) * D2R;
    return norm(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  }
  function sunEq(ms) { return eclToEq(sunEcl(ms), 0, ms); }
  function sunAltAz(lat, lon, ms) {
    var e = sunEq(ms); return altAz(e.ra, e.dec, lat, lon, ms);
  }
  function moonEcl(ms) {   // 月の黄経黄緯(度, 打ち切り)
    var T = (jd(ms) - 2451545.0) / 36525;
    var s = function (a, b) { return Math.sin(norm(a + b * T) * D2R); };
    var lam = norm(218.32 + 481267.881 * T
      + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36)
      + 0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74)
      - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03));
    var bet = 5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89)
      - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21);
    return { lam: lam, bet: bet };
  }
  function moonEq(ms) { var m = moonEcl(ms); return eclToEq(m.lam, m.bet, ms); }

  /* ---- 惑星(平均ケプラー要素 J2000 + 世紀変化率) ---- */
  var EL = {
    '水星': [0.38709927,0.20563593,7.00497902,252.25032350,77.45779628,48.33076593,
             0.00000037,0.00001906,-0.00594749,149472.67411175,0.16047689,-0.12534081],
    '金星': [0.72333566,0.00677672,3.39467605,181.97909950,131.60246718,76.67984255,
             0.00000390,-0.00004107,-0.00078890,58517.81538729,0.00268329,-0.27769418],
    '_地球': [1.00000261,0.01671123,-0.00001531,100.46457166,102.93768193,0.0,
             0.00000562,-0.00004392,-0.01294668,35999.37244981,0.32327364,0.0],
    '火星': [1.52371034,0.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891,
             0.00001847,0.00007882,-0.00813131,19140.30268499,0.44441088,-0.29257343],
    '木星': [5.20288700,0.04838624,1.30439695,34.39644051,14.72847983,100.47390909,
             -0.00011607,-0.00013253,-0.00183714,3034.74612775,0.21252668,0.20469106],
    '土星': [9.53667594,0.05386179,2.48599187,49.95424423,92.59887831,113.66242448,
             -0.00125060,-0.00050991,0.00193609,1222.49362201,-0.41897216,-0.28867794]
  };
  function helio(el, T) {
    var a = el[0] + el[6] * T, e = el[1] + el[7] * T, I = (el[2] + el[8] * T) * D2R;
    var L = el[3] + el[9] * T, w = el[4] + el[10] * T, O = el[5] + el[11] * T;
    var M = norm(L - w) * D2R, om = (w - O) * D2R, Om = O * D2R;
    var E = M;
    for (var i = 0; i < 8; i++) E = M + e * Math.sin(E);
    var xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    var cO = Math.cos(Om), sO = Math.sin(Om), co = Math.cos(om), so = Math.sin(om), cI = Math.cos(I), sI = Math.sin(I);
    return [
      xv * (cO * co - sO * so * cI) - yv * (cO * so + sO * co * cI),
      xv * (sO * co + cO * so * cI) - yv * (sO * so - cO * co * cI),
      xv * (so * sI) + yv * (co * sI)
    ];
  }
  var PMAG = { '水星': 0.2, '金星': -4.2, '火星': 0.8, '木星': -2.4, '土星': 0.6 };
  function planets(ms) {
    var T = (jd(ms) - 2451545.0) / 36525;
    var e = helio(EL['_地球'], T);
    var out = [];
    for (var k in EL) {
      if (k === '_地球') continue;
      var p = helio(EL[k], T);
      var x = p[0] - e[0], y = p[1] - e[1], z = p[2] - e[2];
      var lam = norm(Math.atan2(y, x) * R2D);
      var bet = Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D;
      var eq = eclToEq(lam, bet, ms);
      out.push({ n: k, ra: eq.ra, dec: eq.dec, mag: PMAG[k], t: 'planet' });
    }
    return out;
  }

  return { gmst: gmst, altAz: altAz, sunEq: sunEq, sunEcl: sunEcl, sunAltAz: sunAltAz,
           moonEq: moonEq, moonEcl: moonEcl, planets: planets, eclToEq: eclToEq };
})();
if (typeof module !== 'undefined') module.exports = ASTRO;
