#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""実在地ベースのデモルート4本を生成する。

  都市(晴海・皇居): OSM の道路網(test/fixtures/*-osm.json = Overpass `out geom`)上で
     角を数点だけ指定し、間は歩道優先の最短路で結ぶ(gpx2route.route_on_graph)。
     → 全点が実在の道路上。手描きの概形は岸壁や濠の上を通っていたので廃止した
  山(高尾・富士・南高尾): 実GPX/OSM公開トレースを gpx2route.py で変換した data/real/*.json をそのまま載せる
     (概形は廃止。再生成手順は data/real/README.md)"""
import json, math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gpx2route import (simplify, cumdist, total_gain, enc_poly, enc_ele, auto_ct, hav, _xy,
                       load_osm_ways, route_on_graph, bake_vec, enclosing_loop, orient_loop)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

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

# ── 実ルート: gpx2route.py の --dump-json 出力(data/real/*.json)をそのまま載せる。
#    高尾(2011-03-27 OSM公開トレース)・富士 吉田ルート(2014-08-15 同)・南高尾(実GPX)。再生成手順は data/real/README.md ──
def load_real(rid):
    p = os.path.join(ROOT, 'data', 'real', rid + '.json')
    r = json.load(open(p, encoding='utf-8'))
    assert r['id'] == rid and r.get('real'), f'{p}: gpx2route.py --dump-json の出力ではない'
    sys.stderr.write(f"{r['name']}: {r['dist']/1000:.2f}km +{r['gain']}m 点{len(r['wps'])}WP reg{len(r['reg'])} (実データ)\n")
    return r

TAKAO = load_real('takao')
FUJI = load_real('fuji')
MINAMITAKAO = load_real('minamitakao')

routes = [HARUMI, TAKAO, KOKYO, FUJI, MINAMITAKAO]
out = os.path.join(ROOT, 'src', 'routes.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('// 自動生成: tools/make_field_demo.py\n')
    f.write('// 晴海・皇居は OSM 道路網上の経路、高尾・富士・南高尾は実GPX/OSM公開トレースの変換(© OpenStreetMap contributors)\n')
    f.write('var ROUTES = ' + json.dumps(routes, ensure_ascii=False, separators=(',', ':')) + ';\n')
size = os.path.getsize(out)
sys.stderr.write(f"routes.js 合計 {size/1024:.1f}KB\n")
