#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gpx2route.py v3 の機械検証。合成GPX+偽Overpass JSONで
   emit-query / OSM分類・距離フィルタ / 著名峰マージ / vis / seg / domain判定を踏む。"""
import json, math, os, subprocess, sys, tempfile, zlib

TOOLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools')
FAILS = []
STEP = [0]

def ok(cond, msg):
    STEP[0] += 1
    if cond: print('  \u2713 ' + msg)
    else: print('  \u2717 ' + msg); FAILS.append(msg)

def run(args, cwd=None):
    return subprocess.run([sys.executable, os.path.join(TOOLS, 'gpx2route.py')] + args,
                          capture_output=True, text=True, cwd=cwd)

# ---- 合成データ: 高尾山口(35.632,139.270)→高尾山頂(35.625,139.244) 風の登り ----
def make_gpx(path, flat=False):
    n = 40
    pts = []
    for i in range(n):
        f = i / (n - 1)
        la = 35.6322 - 0.0070 * f
        lo = 139.2699 - 0.0255 * f
        ele = 190 if flat else 190 + 410 * f
        pts.append(f'<trkpt lat="{la:.6f}" lon="{lo:.6f}"><ele>{ele:.0f}</ele></trkpt>')
    wpt = ('<wpt lat="35.629000" lon="139.254000"><name>\u4e2d\u9593\u8336\u5c4b</name><type>hut</type></wpt>')
    open(path, 'w', encoding='utf-8').write(
        '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' + ''.join(pts) +
        '</trkseg></trk>' + wpt + '</gpx>')

def make_osm(path):
    els = [
        # ルート至近の駅(採用)
        {'type': 'node', 'id': 1, 'lat': 35.6323, 'lon': 139.2700,
         'tags': {'railway': 'station', 'name': '\u9ad8\u5c3e\u5c71\u53e3\u99c5'}},
        # ルート至近の温泉(採用・ele無し→ルート標高で補完)
        {'type': 'node', 'id': 2, 'lat': 35.6318, 'lon': 139.2712,
         'tags': {'amenity': 'public_bath', 'bath:type': 'onsen', 'name': '\u6975\u697d\u6e6f'}},
        # way+center の山小屋(採用)
        {'type': 'way', 'id': 3, 'center': {'lat': 35.6270, 'lon': 139.2500},
         'tags': {'tourism': 'alpine_hut', 'name': '\u30c6\u30b9\u30c8\u5c0f\u5c4b', 'ele': '480'}},
        # 神社(採用)
        {'type': 'node', 'id': 4, 'lat': 35.6250, 'lon': 139.2482,
         'tags': {'amenity': 'place_of_worship', 'name': '\u85ac\u738b\u9662'}},
        # ルートから約3km離れた駅(radius 1500m超 → 落ちる)
        {'type': 'node', 'id': 5, 'lat': 35.6600, 'lon': 139.2700,
         'tags': {'railway': 'station', 'name': '\u9060\u3044\u99c5'}},
        # 近傍のOSM峰(採用。FAMOUS高尾山と同名→OSM座標を優先し重複しない)
        {'type': 'node', 'id': 6, 'lat': 35.6252, 'lon': 139.2436,
         'tags': {'natural': 'peak', 'name': '\u9ad8\u5c3e\u5c71', 'ele': '599'}},
        # 60km離れたOSM峰(peak-km 30超・vis指定なし → 落ちる)
        {'type': 'node', 'id': 7, 'lat': 36.16, 'lon': 139.27,
         'tags': {'natural': 'peak', 'name': '\u9060\u5cf0', 'ele': '1500'}},
        # 無名の峰(落ちる)
        {'type': 'node', 'id': 8, 'lat': 35.626, 'lon': 139.246, 'tags': {'natural': 'peak'}},
        # 対象外タグ(落ちる)
        {'type': 'node', 'id': 9, 'lat': 35.6320, 'lon': 139.2701,
         'tags': {'amenity': 'parking', 'name': '\u99d0\u8eca\u5834'}},
        # shop(既定のpoi-typesに無い → 落ちる)
        {'type': 'node', 'id': 10, 'lat': 35.6290, 'lon': 139.2540,
         'tags': {'amenity': 'restaurant', 'name': '\u8336\u5c4b\u98df\u5802'}},
    ]
    json.dump({'elements': els}, open(path, 'w', encoding='utf-8'))

with tempfile.TemporaryDirectory() as td:
    gpx = os.path.join(td, 't.gpx'); make_gpx(gpx)
    gpx_flat = os.path.join(td, 'flat.gpx'); make_gpx(gpx_flat, flat=True)
    osm = os.path.join(td, 'poi.json'); make_osm(osm)
    dump = os.path.join(td, 'route.json')

    # ---- emit-query ----
    r = run([gpx, '--emit-query'])
    ok(r.returncode == 0, 'emit-query exits 0')
    ok('[out:json]' in r.stdout and 'natural' in r.stdout and 'out center' in r.stdout,
       'query has out:json / peak selector / out center')
    ok('public_bath' in r.stdout and 'railway' in r.stdout and 'alpine_hut' in r.stdout,
       'query covers onsen / station / hut')

    # ---- 変換本体 ----
    r = run([gpx, '--id', 'tk', '--name', 'テスト高尾', '--osm', osm,
             '--vis', '富士山,高尾山', '--seg', '0.08-0.22:金比羅台の登り',
             '--seg', '1200-1800:最後の登り', '--dec', '7.6', '--dump-json', dump])
    ok(r.returncode == 0, 'convert exits 0 (stderr: ' + r.stderr.strip().split('\n')[0] + ')')
    j = json.load(open(dump, encoding='utf-8'))
    names = {e['n']: e for e in j['reg']}

    ok('高尾山口駅' in names and names['高尾山口駅']['t'] == 'sta', 'near station adopted as sta')
    ok('極楽湯' in names and names['極楽湯']['t'] == 'onsen', 'onsen adopted via bath:type')
    ok(names.get('極楽湯', {}).get('el', 0) > 100, 'missing ele backfilled from route')
    ok('テスト小屋' in names and names['テスト小屋']['t'] == 'hut', 'way+center hut adopted')
    ok('薬王院' in names and names['薬王院']['t'] == 'shrine', 'shrine adopted')
    ok('遠い駅' not in names, 'station beyond poi-radius dropped')
    ok('遠峰' not in names, 'far peak beyond peak-km dropped (no vis)')
    ok('茶屋食堂' not in names, 'shop dropped by default poi-types')
    ok('駐車場' not in names, 'unclassified tag dropped')
    ok('高尾山' in names and abs(names['高尾山']['lo'] - 139.2436) < 1e-4,
       'OSM peak wins over FAMOUS duplicate (single entry)')
    ok(sum(1 for e in j['reg'] if e['n'] == '高尾山') == 1, 'no duplicate 高尾山')
    ok('富士山' in names and names['富士山']['v'] == 1, 'FAMOUS 富士山 merged & vis=1 via --vis')
    ok(names['高尾山']['v'] == 1, '--vis marks OSM peak solid')
    ok(all(e['v'] == 0 for e in j['reg'] if e['n'] not in ('富士山', '高尾山')),
       'everything else stays dashed (honesty default)')
    ok('丹沢山' in names and names['丹沢山']['v'] == 0, 'nearby FAMOUS merged as dashed')

    total = j['dist']
    ok(len(j['segs']) == 2, 'two segments parsed')
    s0, s1 = j['segs']
    ok(abs(s0['a'] - 0.08 * total) < 2 and abs(s0['b'] - 0.22 * total) < 2, 'ratio seg → meters')
    ok(s1['a'] == 1200 and s1['b'] == 1800, 'absolute seg kept as meters')
    ok(j['dec'] == 7.6, 'declination passed through')
    ok(j['domain'] == 'mountain', 'auto domain: climbing gpx → mountain')
    ok(any(w['n'] == '中間茶屋' for w in j['wps']), 'gpx wpt still snapped (v2 regression)')

    # ---- domain auto: フラット → urban ----
    r = run([gpx_flat, '--id', 'fl', '--name', 'フラット', '--dump-json', dump])
    ok(r.returncode == 0 and json.load(open(dump, encoding='utf-8'))['domain'] == 'urban',
       'auto domain: flat gpx → urban')

    # ---- seg バリデーション ----
    r = run([gpx, '--id', 'x', '--name', 'x', '--seg', '0.5-0.3:逆転'])
    ok(r.returncode != 0, 'inverted seg range rejected')
    r = run([gpx, '--id', 'x', '--name', 'x', '--seg', '0.1-0.4:A', '--seg', '0.3-0.6:B'])
    ok(r.returncode != 0, 'overlapping segs rejected')

# ---- v3.2: DEM(標高タイル)の投入口・デコード・可視レイキャスト ----
sys.path.insert(0, TOOLS)
import gpx2route as G   # noqa: E402

def png_rgb(w, h, rgb):
    """テスト用の最小PNGライタ(8bit truecolor・フィルタ0)。stdlibだけで書く"""
    raw = b''.join(b'\x00' + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    def chunk(t, d):
        c = t + d
        return len(d).to_bytes(4, 'big') + c + (zlib.crc32(c) & 0xffffffff).to_bytes(4, 'big')
    ihdr = w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + bytes([8, 2, 0, 0, 0])
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

def enc_elev(m):
    """標高m → 地理院DEMのRGB。Noneは無効値(128,0,0)"""
    if m is None: return (128, 0, 0)
    x = int(round(m * 100))
    if x < 0: x += 0x1000000
    return ((x >> 16) & 255, (x >> 8) & 255, x & 255)

def write_dem(root, z, fn, la_c, lo_c, span_deg, side=64):
    """(la,lo)→標高 の関数から {z}/{x}/{y}.png を書き出す"""
    x0 = int(G.lon2tx(lo_c - span_deg, z)); x1 = int(G.lon2tx(lo_c + span_deg, z))
    y0 = int(G.lat2ty(la_c + span_deg, z)); y1 = int(G.lat2ty(la_c - span_deg, z))
    for tx in range(x0, x1 + 1):
        os.makedirs(os.path.join(root, str(z), str(tx)), exist_ok=True)
        for ty in range(y0, y1 + 1):
            buf = bytearray(side * side * 3)
            for py in range(side):
                n = math.pi - 2 * math.pi * (ty + (py + 0.5) / side) / (2 ** z)
                la = math.degrees(math.atan(math.sinh(n)))
                for px in range(side):
                    lo = (tx + (px + 0.5) / side) / (2 ** z) * 360.0 - 180.0
                    r, g, b = enc_elev(fn(la, lo))
                    i = (py * side + px) * 3
                    buf[i], buf[i + 1], buf[i + 2] = r, g, b
            open(os.path.join(root, str(z), str(tx), f'{ty}.png'), 'wb').write(png_rgb(side, side, bytes(buf)))
    return (x1 - x0 + 1) * (y1 - y0 + 1)

print('[dem]')
# --- 単体: PNG読み出しと標高デコード ---
with tempfile.TemporaryDirectory() as tmp:
    p = os.path.join(tmp, 't.png')
    vals = [0.0, 2.56, 110.0, -0.01, None]
    rgb = b''.join(bytes(enc_elev(v)) for v in vals)
    open(p, 'wb').write(png_rgb(len(vals), 1, rgb))
    w, h, out = G.read_png_rgb(p)
    got = [G.dem_elev_rgb(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]) for i in range(len(vals))]
    ok((w, h) == (len(vals), 1), 'read_png_rgb returns image size')
    ok(got[0] == 0 and abs(got[1] - 2.56) < 1e-9 and abs(got[2] - 110.0) < 1e-9,
       'DEM RGB roundtrip for positive elevations')
    ok(abs(got[3] + 0.01) < 1e-9, 'DEM negative elevation decodes')
    ok(got[4] is None, 'DEM invalid marker (128,0,0) decodes to None, not 0m')

# --- CLI: --emit-dem-fetch ---
with tempfile.TemporaryDirectory() as td:
    gpx = os.path.join(td, 'r.gpx'); make_gpx(gpx)
    r = run([gpx, '--emit-dem-fetch', '--dem-radius-km', '5', '--dem-zoom', '12'])
    ok(r.returncode == 0 and r.stdout.startswith('#!/bin/sh'), 'emit-dem-fetch prints a shell script')
    ok('cyberjapandata.gsi.go.jp/xyz/dem_png/12/' in r.stdout, 'fetch script targets the right tiles')
    ok('地理院タイル' in r.stdout, 'fetch script carries the required attribution')
    n_curl = r.stdout.count('curl ')
    ok(n_curl >= 4, f'fetch script covers the bbox ({n_curl} tiles)')
    r2 = run([gpx, '--emit-dem-fetch', '--dem-radius-km', '20', '--dem-zoom', '12'])
    ok(r2.stdout.count('curl ') > n_curl, 'wider radius asks for more tiles')

# --- レイキャスト: 平地に壁を1本立てて遮蔽を確かめる ---
with tempfile.TemporaryDirectory() as td:
    LA, LO, Z = 35.00, 139.00, 10
    WALL_S, WALL_N, WALL_H = 35.09, 35.11, 2000.0     # 緯度帯の壁

    def terrain(la, lo):
        return WALL_H if WALL_S <= la <= WALL_N else 100.0

    root = os.path.join(td, 'dem')
    ntile = write_dem(root, Z, terrain, LA, LO, 0.25)
    dem = G.DemTiles(root)
    ok(dem.z == Z and ntile >= 1, f'DemTiles picks the deepest zoom ({ntile} synthetic tiles)')
    ok(abs(dem.elev(35.00, 139.00) - 100.0) < 0.5, 'DemTiles samples the plain')
    ok(abs(dem.elev(35.10, 139.00) - WALL_H) < 0.5, 'DemTiles samples the wall')

    obs, obs_el = (35.00, 139.00), 100.0
    near = G.sight_blocked(obs, obs_el, (35.05, 139.00), 300.0, dem)
    far = G.sight_blocked(obs, obs_el, (35.20, 139.00), 1000.0, dem)
    ok(near is False, 'peak on this side of the wall is visible')
    ok(far is True, 'peak behind a 2000m wall is blocked')
    over = G.sight_blocked(obs, obs_el, (35.20, 139.00), 9000.0, dem)
    ok(over is False, 'a peak tall enough to clear the wall is visible again')
    # 壁の無い東へ82km・標高3000m(地平線上)。DEMは半分ほどで切れる
    # → 遮蔽は見つからないが「不明」であって「見える」ではない
    off = G.sight_blocked(obs, obs_el, (35.00, 139.90), 3000.0, dem)
    ok(off is None, 'a ray leaving DEM coverage is unknown, not visible')
    # 逆に、地形が平坦でも遠すぎる対象は地球の丸みで地平線下になる(遮蔽扱い)
    horizon = G.sight_blocked(obs, obs_el, (35.00, 139.30), 120.0, dem)
    ok(horizon is True, 'a low target beyond the horizon counts as blocked')

    # 遮蔽側へ倒す設計: 地形は周囲1セルの最大で見る
    ok(dem.elev_max(35.089, 139.00) >= dem.elev(35.089, 139.00),
       'elev_max never reports lower terrain than elev')

# --- CLI: --dem-tiles で v: が自動で付き、--vis が上書きする ---
with tempfile.TemporaryDirectory() as td:
    LA, LO, Z = 35.00, 139.00, 10
    def terrain(la, lo):
        return 2000.0 if 35.09 <= la <= 35.11 else 100.0
    root = os.path.join(td, 'dem'); write_dem(root, Z, terrain, LA, LO, 0.25)

    gpx = os.path.join(td, 'r.gpx')
    pts = ''.join(f'<trkpt lat="{LA + 0.002 * i:.6f}" lon="{LO:.6f}"><ele>100</ele></trkpt>' for i in range(6))
    open(gpx, 'w', encoding='utf-8').write(
        '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' + pts + '</trkseg></trk></gpx>')
    osm = os.path.join(td, 'p.json')
    json.dump({'elements': [
        {'type': 'node', 'id': 1, 'lat': 35.05, 'lon': 139.00,
         'tags': {'natural': 'peak', 'name': '手前峰', 'ele': '300'}},
        {'type': 'node', 'id': 2, 'lat': 35.20, 'lon': 139.00,
         'tags': {'natural': 'peak', 'name': '壁の向こう峰', 'ele': '1000'}},
    ]}, open(osm, 'w', encoding='utf-8'))
    dump = os.path.join(td, 'o.json')

    r = run([gpx, '--id', 'd', '--name', 'DEM', '--osm', osm, '--dump-json', dump])
    reg = {x['n']: x for x in json.load(open(dump, encoding='utf-8'))['reg']}
    ok(reg['手前峰']['v'] == 0 and reg['壁の向こう峰']['v'] == 0,
       'without --dem-tiles nothing is claimed visible')

    r = run([gpx, '--id', 'd', '--name', 'DEM', '--osm', osm, '--dem-tiles', root, '--dump-json', dump])
    reg = {x['n']: x for x in json.load(open(dump, encoding='utf-8'))['reg']}
    ok(r.returncode == 0, 'conversion with --dem-tiles succeeds')
    ok(reg['手前峰']['v'] == 1, 'DEM raycast marks the unobstructed peak visible')
    ok(reg['壁の向こう峰']['v'] == 0, 'DEM raycast leaves the occluded peak dashed')
    ok('DEM z' in r.stderr and '可視' in r.stderr, 'stderr reports what the DEM decided')

    r = run([gpx, '--id', 'd', '--name', 'DEM', '--osm', osm, '--dem-tiles', root,
             '--vis', '壁の向こう峰', '--dump-json', dump])
    reg = {x['n']: x for x in json.load(open(dump, encoding='utf-8'))['reg']}
    ok(reg['壁の向こう峰']['v'] == 1, '--vis overrides the DEM verdict (manual confirmation wins)')

    # GPXのele信頼性チェック: 合成GPXは100m、DEMも100m → 差ほぼ0で警告なし
    ok('GPX標高 vs DEM' in r.stderr, 'stderr reports the GPX-vs-DEM elevation check')
    ok('GPXの標高が疑わしい' not in r.stderr, 'consistent GPX elevations raise no warning')

    gpx_bad = os.path.join(td, 'bad.gpx')
    bad = ''.join(f'<trkpt lat="{LA + 0.002 * i:.6f}" lon="{LO:.6f}"><ele>900</ele></trkpt>' for i in range(6))
    open(gpx_bad, 'w', encoding='utf-8').write(
        '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' + bad + '</trkseg></trk></gpx>')
    rb = run([gpx_bad, '--id', 'b', '--name', 'BAD', '--dem-tiles', root])
    ok('GPXの標高が疑わしい' in rb.stderr, 'GPX elevations far off the DEM are flagged')

    # 標高補完: ele無しPOIがDEMで埋まる
    json.dump({'elements': [
        {'type': 'node', 'id': 3, 'lat': 35.004, 'lon': 139.0005,
         'tags': {'railway': 'station', 'name': '無標高駅'}},
    ]}, open(osm, 'w', encoding='utf-8'))
    run([gpx, '--id', 'd', '--name', 'DEM', '--osm', osm, '--dem-tiles', root, '--dump-json', dump])
    st = [x for x in json.load(open(dump, encoding='utf-8'))['reg'] if x['n'] == '無標高駅']
    ok(st and abs(st[0]['el'] - 100) <= 1, 'missing POI elevation filled from DEM')

# --- 欠損タイルは「不明」であって「見える」ではない ---
with tempfile.TemporaryDirectory() as td:
    root = os.path.join(td, 'dem'); os.makedirs(os.path.join(root, '10', '900'))
    open(os.path.join(root, '10', '900', '400.png'), 'wb').write(b'not a png')
    dem = G.DemTiles(root)
    ok(dem.elev(35.0, 139.0) is None, 'a corrupt/absent tile reads as missing, not as 0m')

print(f"\n{STEP[0] - len(FAILS)}/{STEP[0]} passed")
sys.exit(1 if FAILS else 0)
