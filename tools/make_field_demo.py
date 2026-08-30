#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""実在地ベースのデモルート3本(概形)を生成する。
※主要地点(緯度経度)を滑らかに結んだ近似形。実測トレイルではない。
   実山行には gpx2route.py で実GPXから変換したルートを使うこと。"""
import json, math, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gpx2route import simplify, cumdist, total_gain, enc_poly, enc_ele, auto_ct, hav

random.seed(11)

def to_xy(anchors, lat0, lon0):
    k = math.cos(math.radians(lat0))
    return [((lo - lon0) * k * 111320.0, (la - lat0) * 110540.0, e) for la, lo, e in anchors]

def to_ll(xy, lat0, lon0):
    k = math.cos(math.radians(lat0))
    return [(lat0 + y / 110540.0, lon0 + x / (111320.0 * k), e) for x, y, e in xy]

def catmull3(ps, seg=18.0):
    """(x,y,ele) を Catmull-Rom 補間"""
    P = [ps[0]] + list(ps) + [ps[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i-1], P[i], P[i+1], P[i+2]
        L = math.hypot(p2[0]-p1[0], p2[1]-p1[1])
        n = max(2, int(L / seg))
        for j in range(n):
            t = j / n; t2, t3 = t*t, t*t*t
            def cr(a):
                return 0.5*((2*p1[a]) + (-p0[a]+p2[a])*t + (2*p0[a]-5*p1[a]+4*p2[a]-p3[a])*t2 + (-p0[a]+3*p1[a]-3*p2[a]+p3[a])*t3)
            out.append((cr(0), cr(1), cr(2)))
    out.append(tuple(ps[-1]))
    return out

def wiggle(xy, amp=6.0, sw_amp=0.0, sw_wl=8.0):
    """進行方向直交の蛇行。sw_amp>0 で九十九折(スイッチバック)を重畳"""
    out = []
    ph1, ph2 = random.random()*9, random.random()*9
    for i, (x, y, e) in enumerate(xy):
        a, b = xy[max(i-1, 0)], xy[min(i+1, len(xy)-1)]
        dx, dy = b[0]-a[0], b[1]-a[1]
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy/L, dx/L
        off = amp*math.sin(i/5.0+ph1) + amp*0.4*math.sin(i/1.9+ph2)
        if sw_amp: off += sw_amp * math.sin(i / sw_wl * math.pi)
        out.append((x+nx*off, y+ny*off, e))
    return out

def build(rid, name, anchors, wp_defs, closed=False, piston=False, sw=(0, 8)):
    lat0, lon0 = anchors[0][0], anchors[0][1]
    xy = catmull3(to_xy(anchors, lat0, lon0))
    xy = wiggle(xy, 6.0, sw[0], sw[1])
    if piston: xy = xy + xy[::-1]
    if closed: xy.append(xy[0])
    pts = to_ll(xy, lat0, lon0)
    pts = simplify(pts, 1.8)
    cum = cumdist(pts)
    total, gain = cum[-1], total_gain(pts)
    # WP: (lat,lon,name,type) を沿道距離へスナップ(ピストンは往路側=最初の最近点)
    wps = []
    for la, lo, n, t in wp_defs:
        best, bd = 0, 1e18
        for i, p in enumerate(pts):
            d = hav((la, lo), p)
            if d < bd - 1: bd, best = d, i
        wps.append({'d': round(cum[best]), 'n': n, 't': t})
    if piston:  # 復路側のWPをミラーで追加(山頂以外)
        extra = [{'d': round(total - w['d']), 'n': w['n'], 't': w['t']}
                 for w in wps if 0 < w['d'] < total * 0.49]
        wps += extra
    wps.append({'d': round(total), 'n': wp_defs[-1][2] if not (piston or closed) else '下山口', 't': 'goal'})
    wps = sorted({w['d']: w for w in wps}.values(), key=lambda w: w['d'])
    obj = {'id': rid, 'name': name, 'dist': round(total), 'gain': round(gain),
           'poly': enc_poly(pts), 'ele': enc_ele(pts), 'wps': wps,
           'cts': [[c[0], round(c[1])] for c in auto_ct(pts, cum)], 'demo': True}
    sys.stderr.write(f"{name}: {total/1000:.1f}km +{gain:.0f}m 点{len(pts)} CT{obj['cts'][-1][1]}分\n")
    return obj

# ── 晴海フラッグ周回(平坦・実歩行テスト用。西岸→街区→晴海緑道→ふ頭公園) ──
HARUMI = build('harumi', '晴海フラッグ周回 [概形]',
    [(35.6474, 139.7717, 3), (35.6491, 139.7736, 3), (35.6508, 139.7752, 3),
     (35.6521, 139.7768, 4), (35.6512, 139.7786, 4), (35.6496, 139.7793, 3),
     (35.6479, 139.7784, 3), (35.6463, 139.7762, 3), (35.6462, 139.7737, 3)],
    [(35.6474, 139.7717, '晴海ふ頭公園', 'start'),
     (35.6521, 139.7768, '北端折返し', 'wp'),
     (35.6496, 139.7793, '晴海緑道公園', 'wp')],
    closed=True)

# ── 富士山 吉田ルート(五合目→頂上 片道。七合目以降に九十九折を重畳) ──
FUJI = build('fuji', '富士山 吉田ルート [概形]',
    [(35.3966, 138.7333, 2305), (35.3931, 138.7372, 2350), (35.3903, 138.7398, 2390),
     (35.3876, 138.7422, 2530), (35.3852, 138.7438, 2700), (35.3812, 138.7425, 2910),
     (35.3778, 138.7408, 3100), (35.3752, 138.7388, 3250), (35.3732, 138.7368, 3400),
     (35.3712, 138.7352, 3520), (35.3697, 138.7340, 3600), (35.3672, 138.7332, 3715)],
    [(35.3966, 138.7333, '五合目', 'start'),
     (35.3903, 138.7398, '六合目', 'wp'),
     (35.3852, 138.7438, '七合目', 'hut'),
     (35.3778, 138.7408, '八合目', 'hut'),
     (35.3732, 138.7368, '本八合目 [下山道分岐]', 'escape'),
     (35.3697, 138.7340, '九合目', 'wp'),
     (35.3672, 138.7332, '吉田口頂上', 'peak')],
    sw=(45, 6))

# ── 高尾山 1号路 往復(ピストン。単調マッチングの実地テストに最適) ──
TAKAO = build('takao', '高尾山 1号路 往復 [概形]',
    [(35.6322, 139.2699, 190), (35.6318, 139.2678, 210), (35.6330, 139.2655, 300),
     (35.6337, 139.2632, 390), (35.6320, 139.2600, 430), (35.6304, 139.2565, 472),
     (35.6291, 139.2537, 490), (35.6273, 139.2505, 505), (35.6252, 139.2478, 530),
     (35.6247, 139.2455, 560), (35.6252, 139.2436, 599)],
    [(35.6322, 139.2699, '高尾山口駅', 'start'),
     (35.6337, 139.2632, '金比羅台', 'wp'),
     (35.6304, 139.2565, 'ケーブル高尾山駅', 'hut'),
     (35.6252, 139.2478, '薬王院', 'junction'),
     (35.6252, 139.2436, '高尾山山頂', 'peak')],
    piston=True)

# ── 皇居ラン 1周(反時計回り・桜田門起点。内堀通り沿いの定番5km) ──
KOKYO = build('kokyo', '皇居ラン 1周 [概形]',
    [(35.6772, 139.7524, 6), (35.6790, 139.7563, 5), (35.6817, 139.7580, 5),
     (35.6852, 139.7594, 5), (35.6890, 139.7578, 6), (35.6910, 139.7550, 8),
     (35.6923, 139.7512, 14), (35.6917, 139.7468, 22), (35.6892, 139.7438, 26),
     (35.6852, 139.7416, 30), (35.6818, 139.7432, 24), (35.6795, 139.7462, 15)],
    [(35.6772, 139.7524, '桜田門', 'start'),
     (35.6852, 139.7594, '大手門', 'wp'),
     (35.6910, 139.7550, '竹橋', 'wp'),
     (35.6852, 139.7416, '半蔵門', 'wp')],
    closed=True)

routes = [HARUMI, TAKAO, KOKYO, FUJI]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'routes.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('// 自動生成: tools/make_field_demo.py\n')
    f.write('// ※[概形]ルートは主要地点を結んだ近似。実山行には gpx2route.py で実GPXを変換して差し替えること\n')
    f.write('var ROUTES = ' + json.dumps(routes, ensure_ascii=False, separators=(',', ':')) + ';\n')
size = os.path.getsize(out)
sys.stderr.write(f"routes.js 合計 {size/1024:.1f}KB\n")
