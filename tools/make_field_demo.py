#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""実在地ベースのデモルート4本を生成する。

  都市(晴海・皇居): OSM の道路網(test/fixtures/*-osm.json = Overpass `out geom`)上で
     角を数点だけ指定し、間は歩道優先の最短路で結ぶ(gpx2route.route_on_graph)。
     → 全点が実在の道路上。手描きの概形は岸壁や濠の上を通っていたので廃止した
  山(高尾・富士): 主要地点を滑らかに結んだ近似形 [概形]。実山行には gpx2route.py で
     実GPXから変換したルートを使うこと"""
import json, math, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gpx2route import (simplify, cumdist, total_gain, enc_poly, enc_ele, auto_ct, hav, _xy,
                       load_osm_ways, route_on_graph, bake_vec, enclosing_loop, orient_loop)

random.seed(11)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

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

def snap_wps(pts, cum, wp_defs):
    """WP: (lat,lon,name,type) を沿道距離へスナップ(ピストンは往路側=最初の最近点)。
       頂点ではなく線分へ射影する。OSM経路は直線区間が長く簡略化で頂点が疎になるので、
       頂点最寄りだと交差点の WP が数百m ずれる(晴海 5-1号線で実測 363m vs 実際 1180m)"""
    lat0 = pts[0][0]
    xy = [_xy(p, lat0) for p in pts]
    wps = []
    for la, lo, n, t in wp_defs:
        q = _xy((la, lo, 0), lat0)
        best, bd = 0.0, 1e18
        for i in range(1, len(xy)):
            a, b = xy[i - 1], xy[i]
            vx, vy = b[0] - a[0], b[1] - a[1]
            L2 = vx * vx + vy * vy
            f = 0.0 if L2 == 0 else max(0.0, min(1.0, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / L2))
            d = math.hypot(q[0] - (a[0] + vx * f), q[1] - (a[1] + vy * f))
            if d < bd - 1: bd, best = d, cum[i - 1] + (cum[i] - cum[i - 1]) * f
        wps.append({'d': 0 if t == 'start' else round(best), 'n': n, 't': t})   # 起点は定義上 0m(閉路の起点ノードは門から数十m離れる)
    return wps

def finish(rid, name, pts, wp_defs, closed, piston, extra=None):
    cum = cumdist(pts)
    total, gain = cum[-1], total_gain(pts)
    wps = snap_wps(pts, cum, wp_defs)
    if piston:  # 復路側のWPをミラーで追加(山頂以外)
        wps += [{'d': round(total - w['d']), 'n': w['n'], 't': w['t']}
                for w in wps if 0 < w['d'] < total * 0.49]
    # 周回のゴール名は core.rotateLoop と同じ「ゴール (起点名)」。都市の周回に「下山口」は出さない
    goal_n = wp_defs[-1][2] if not (piston or closed) else ('下山口' if piston else 'ゴール (' + wp_defs[0][2] + ')')
    wps.append({'d': round(total), 'n': goal_n, 't': 'goal'})
    wps = sorted({w['d']: w for w in wps}.values(), key=lambda w: w['d'])
    obj = {'id': rid, 'name': name, 'dist': round(total), 'gain': round(gain),
           'poly': enc_poly(pts), 'ele': enc_ele(pts), 'wps': wps,
           'cts': [[c[0], round(c[1])] for c in auto_ct(pts, cum)], 'demo': True}
    if extra: obj.update(extra)
    sys.stderr.write(f"{name}: {total/1000:.2f}km +{gain:.0f}m 点{len(pts)} CT{obj['cts'][-1][1]}分\n")
    return obj

def build(rid, name, anchors, wp_defs, closed=False, piston=False, sw=(0, 8)):
    """山の概形: Catmull-Rom + 蛇行"""
    lat0, lon0 = anchors[0][0], anchors[0][1]
    xy = catmull3(to_xy(anchors, lat0, lon0))
    xy = wiggle(xy, 6.0, sw[0], sw[1])
    if piston: xy = xy + xy[::-1]
    if closed: xy.append(xy[0])
    pts = simplify(to_ll(xy, lat0, lon0), 1.8)
    return finish(rid, name, pts, wp_defs, closed, piston)

def build_osm(rid, name, fixture, corners, wp_defs, snap_r=200.0, around=None):
    """都市の周回。around=(lat,lon) なら「その点を囲む最短の閉路」(内側の歩道リング)を道路網から求め、
       corners[0] を起点・反時計回りに揃える(皇居: 角を門の位置に置くと外苑側へ引っ張られて 5.7km になった。
       囲む閉路なら 5.06km = 公式約5.0km)。around 無しなら角(lat,lon,ele)を歩道優先の最短路で順に結ぶ。
       どちらも corners の標高を沿道距離で線形補間する"""
    fx = os.path.join(ROOT, 'test', 'fixtures', fixture)
    ways = load_osm_ways([fx])
    guide = [(la, lo, float(e)) for la, lo, e in corners] + [(corners[0][0], corners[0][1], float(corners[0][2]))]
    if around:
        ring, st = enclosing_loop(ways, around, 'urban')
        if not ring: raise SystemExit(f"{rid}: {around} を囲む閉路が無い {st}")
        pts = orient_loop(ring, guide[0], ccw=True)
        sys.stderr.write(f"{rid}: 囲む閉路 半径{st['radius']:.0f}m {st['sub']} {st['len']:.0f}m\n")
        st = {'ok': len(guide) - 1, 'skipped': 0}
    else:
        pts, st = route_on_graph(guide, ways, 'urban', 250.0, snap_r, K=8, LAM=2.5, streets=True, via_pts=guide)
    if st['ok'] != len(guide) - 1 or st['skipped']:
        raise SystemExit(f"{rid}: 角を結べない脚がある {st}")
    # 標高: 角の標高を沿道距離で線形補間(道路グラフには標高が無い。都市は平坦なので十分)
    cum = cumdist(pts)
    ki = []
    for la, lo, _e in guide:
        ki.append(min(range(len(pts)), key=lambda i: hav((la, lo), pts[i])))
    ki[-1] = len(pts) - 1
    out = []
    for i, p in enumerate(pts):
        j = 0
        while j < len(ki) - 2 and i >= ki[j + 1]: j += 1
        a, b = ki[j], ki[j + 1]
        f = (cum[i] - cum[a]) / max(1e-9, cum[b] - cum[a]) if b > a else 0.0
        f = min(1.0, max(0.0, f))
        out.append((p[0], p[1], guide[j][2] + (guide[j + 1][2] - guide[j][2]) * f))
    pts = simplify(out, 1.8)
    if hav(pts[0], pts[-1]) > 1: pts.append(pts[0])
    vec = bake_vec(pts, ways, 400.0, 6.0, 30.0)
    sys.stderr.write(f"{rid}: OSM経路 脚{st['ok']} / vec {' '.join(f'{k}{len(v)}' for k, v in vec.items())}\n")
    return finish(rid, name, pts, wp_defs, True, False, {'vec': vec})

# ── 晴海フラッグ 街区一周(平坦・実歩行テスト用)。
#    日比谷豊洲埠頭東雲町線 → 区画道路5-3号線 → 5-4号線 → 5-1号線 → 環二通り。角は交差点 ──
HARUMI = build_osm('harumi', '晴海フラッグ 街区一周', 'harumi-osm.json',
    [(35.65255, 139.77793, 3),   # 北角: 日比谷豊洲埠頭東雲町線 × 環二通り
     (35.65040, 139.77453, 3),   # 西: × 区画道路5-2/5-3号線
     (35.64869, 139.77201, 3),   # 南西角: 5-3 × 5-4号線(晴海ふ頭公園前)
     (35.64862, 139.77463, 3),   # 南: 5-4号線の屈曲
     (35.64930, 139.77565, 3),   # 5-4 × 5-1 × 5-2号線
     (35.65143, 139.77880, 4)],  # 東角: 5-1号線 × 環二通り
    [(35.65255, 139.77793, '北角(環二通り)', 'start'),
     (35.64869, 139.77201, '晴海ふ頭公園前', 'wp'),
     (35.64930, 139.77565, '5-1号線入口', 'wp')])

# ── 皇居ラン 1周(反時計回り・桜田門起点。皇居を囲む最短の閉路=内堀通り〜代官町通りの内側歩道) ──
KOKYO = build_osm('kokyo', '皇居ラン 1周', 'kokyo-osm.json', around=(35.6852, 139.7528), corners=
    [(35.6772, 139.7524, 6),     # 桜田門
     (35.6862, 139.7607, 5),     # 大手門
     (35.6910, 139.7550, 8),     # 竹橋
     (35.6852, 139.7416, 30)],   # 半蔵門(最高点)
    wp_defs=[(35.6772, 139.7524, '桜田門', 'start'),
     (35.6862, 139.7607, '大手門', 'wp'),
     (35.6910, 139.7550, '竹橋', 'wp'),
     (35.6852, 139.7416, '半蔵門', 'wp')])

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

routes = [HARUMI, TAKAO, KOKYO, FUJI]
out = os.path.join(ROOT, 'src', 'routes.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('// 自動生成: tools/make_field_demo.py\n')
    f.write('// 晴海・皇居は OSM 道路網上の経路(© OpenStreetMap contributors)。[概形]は主要地点を結んだ近似で、\n')
    f.write('// 実山行には gpx2route.py で実GPXを変換して差し替えること\n')
    f.write('var ROUTES = ' + json.dumps(routes, ensure_ascii=False, separators=(',', ':')) + ';\n')
size = os.path.getsize(out)
sys.stderr.write(f"routes.js 合計 {size/1024:.1f}KB\n")
