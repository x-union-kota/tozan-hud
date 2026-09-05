#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gpx2route.py v3 の機械検証。合成GPX+偽Overpass JSONで
   emit-query / OSM分類・距離フィルタ / 著名峰マージ / vis / seg / domain判定を踏む。"""
import json, math, os, random, subprocess, sys, tempfile, zlib

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

# ---- v3.2: OSM道路ベクタ(ルート吸着 --snap-osm / 焼き込み vec) ----
print('[osm-vec]')

def way(id_, tags, line):
    return {'type': 'way', 'id': id_, 'tags': tags,
            'geometry': [{'lat': la, 'lon': lo} for (la, lo) in line]}

# 東西にまっすぐ伸びる歩行者道を「正解」にする
LA0, LO0 = 35.0, 139.0
KX = 111320.0 * math.cos(math.radians(LA0))
TRUTH = [(LA0, LO0 + i * 20.0 / KX) for i in range(61)]        # 20m刻み・全長1200m

with tempfile.TemporaryDirectory() as td:
    osm = os.path.join(td, 'ways.json')
    json.dump({'elements': [
        way(1, {'highway': 'pedestrian', 'name': '正解の道'}, TRUTH),
        # 30m北を並走する歩道(点ごとの最近傍だと交互に飛びつく相手)
        way(2, {'highway': 'footway'}, [(LA0 + 30.0 / 110540.0, lo) for (_, lo) in TRUTH]),
        # 直交する道(進行方向フィルタで候補から外れるべき)
        way(3, {'highway': 'residential'},
            [(LA0 - 200.0 / 110540.0 + j * 20.0 / 110540.0, LO0 + 600.0 / KX) for j in range(21)]),
        way(4, {'railway': 'rail'}, [(LA0 - 80.0 / 110540.0, lo) for (_, lo) in TRUTH]),
        way(5, {'natural': 'water'}, [(LA0 - 120.0 / 110540.0, lo) for (_, lo) in TRUTH]),
        # 車専用道: 吸着候補から外れる
        way(6, {'highway': 'motorway'}, [(LA0 + 8.0 / 110540.0, lo) for (_, lo) in TRUTH]),
    ]}, open(osm, 'w', encoding='utf-8'))

    ways = G.load_osm_ways([osm])
    kinds = [w[0] for w in ways]
    ok(kinds.count('road') == 4 and kinds.count('rail') == 1 and kinds.count('water') == 1,
       'load_osm_ways classifies road / rail / water from `out geom`')

    truth3 = [(la, lo, 5.0) for (la, lo) in TRUTH]
    tlen = G.cumdist(truth3)[-1]

    # GPSノイズを載せた「荒れたGPX」を実パイプライン(simplify→snap)に通す
    random.seed(11)
    raw = [(p[0] + random.gauss(0, 6) / 110540.0, p[1] + random.gauss(0, 6) / KX, p[2])
           for p in G.densify(truth3, 5.0)]
    noisy = G.simplify(raw, 6.0)
    snapped, st = G.snap_to_osm(noisy, ways, 'urban', 60.0)
    fixed = G.simplify(snapped, 6.0)

    dv0 = G.route_deviation(noisy, truth3)
    dv1 = G.route_deviation(fixed, truth3)
    len0, len1 = G.cumdist(noisy)[-1], G.cumdist(fixed)[-1]
    ok(dv1[0] < dv0[0], f'snap moves the noisy track closer to the real road ({dv0[0]:.1f}m → {dv1[0]:.1f}m)')
    ok(abs(len1 - tlen) < abs(len0 - tlen),
       f'snap removes the length inflation ({len0:.0f}m → {len1:.0f}m, truth {tlen:.0f}m)')
    ok(st['max'] <= 60.0 + 1e-6, 'no point is moved further than --snap-max')
    ok(st['snapped'] > st['total'] * 0.8, 'most points find a road to sit on')

    # 単調化なしの素朴な最近傍射影より良いこと(この2段が要るという実測の裏取り)
    ok(len1 < len0 * 0.8, 'arc-length monotonisation is what actually removes the inflation')

    # 道から離れた区間は吸着しない(堀・ブロック越えの誤吸着防止)
    far = [(LA0 + 300.0 / 110540.0, LO0 + i * 20.0 / KX, 5.0) for i in range(20)]
    _, stf = G.snap_to_osm(far, ways, 'urban', 60.0)
    ok(stf['snapped'] == 0, 'points with no road within --snap-max keep their original coordinates')

    # 車専用道へは吸着しない
    on_mw = [(LA0 + 8.0 / 110540.0, LO0 + i * 20.0 / KX, 5.0) for i in range(20)]
    sn_mw, _ = G.snap_to_osm(on_mw, ways, 'urban', 60.0)
    dmw = G.route_deviation(sn_mw, [(la, lo, 0) for (la, lo) in TRUTH])
    ok(dmw[0] < 8.0, 'a track on a motorway is pulled to the walkable road, never onto the motorway')

    # ---- CLI: vec 焼き込みと各種オフスイッチ ----
    gpx = os.path.join(td, 'r.gpx')
    open(gpx, 'w', encoding='utf-8').write(
        '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' +
        ''.join(f'<trkpt lat="{p[0]:.6f}" lon="{p[1]:.6f}"><ele>5</ele></trkpt>' for p in noisy) +
        '</trkseg></trk></gpx>')

    r = run([gpx, '--id', 'v', '--name', 'VEC', '--osm', osm])
    ok('vec:{' in r.stdout, 'vec block is baked into the route object')
    ok('"road"' in r.stdout and '"rail"' in r.stdout and '"water"' in r.stdout,
       'vec carries road / rail / water groups')
    ok('snap-osm:' in r.stderr, 'stderr reports what the snap did')
    ok('距離' in r.stderr and '→' in r.stderr, 'stderr reports the distance change')

    r2 = run([gpx, '--id', 'v', '--name', 'VEC', '--osm', osm, '--no-vec'])
    ok('vec:{' not in r2.stdout, '--no-vec suppresses the baked vectors')
    r3 = run([gpx, '--id', 'v', '--name', 'VEC', '--osm', osm, '--no-snap'])
    ok('snap-osm:' not in r3.stderr, '--no-snap skips the snapping entirely')
    ok(len(r3.stdout) != len(r.stdout), '--no-snap yields different geometry than snapped')

    r4 = run([gpx, '--id', 'v', '--name', 'VEC', '--osm', osm, '--vec-kb', '0.02'])
    ok(len(r4.stdout) < len(r.stdout) and '"road"' in r4.stdout,
       'vec size budget drops the lowest-priority lines but keeps the main road')

    r5 = run([gpx, '--emit-query'])
    ok('out geom' in r5.stdout, 'emit-query asks for way geometry (needed for vec and snap)')
    ok('"highway"' in r5.stdout and '"railway"' in r5.stdout, 'emit-query covers highway and railway ways')

# ---- v3.2: 磁気偏角(WMM) ----
# NOAAの係数ファイルはリポジトリに置かない(オフライン2段構え)ので、
# 解析的に答えが分かる合成モデルで検証する。実データとの突き合わせは
#   gpx2route.py --wmm WMM****COF.zip --wmm-test WMM_TEST_VALUES.txt
# で誰でも再現できる(v3.2 実行時: 12点 / 偏角の最大誤差 0.0046° / 成分 0.05nT で一致)。
print('[wmm]')

def cof(lines, epoch=2025.0):
    body = f'    {epoch}            SYNTH     01/01/2025\n' + '\n'.join(lines) + '\n' + '9' * 48 + '\n'
    f = tempfile.NamedTemporaryFile('w', suffix='.COF', delete=False, encoding='utf-8')
    f.write(body); f.close()
    return f.name

with tempfile.TemporaryDirectory() as td:
    # ① 軸対称ダイポール(g10のみ): 偏角はどこでも0でなければならない
    axial = G.load_wmm(cof(['  1  0  -30000.0       0.0        0.0        0.0']))
    worst = max(abs(G.wmm_declination(axial, la, lo, 0.0, 2025.0))
                for la in (-60, -20, 0, 35, 70) for lo in (-170, -60, 0, 45, 139, 175))
    ok(worst < 1e-9, f'axial dipole gives zero declination everywhere (max {worst:.2e}°)')

    # ダイポールの基本性質: 極の全磁力 = 赤道の2倍
    Xe, Ye, Ze = G.wmm_field(axial, 0.0, 0.0, 0.0, 2025.0)
    Xp, Yp, Zp = G.wmm_field(axial, 90.0, 0.0, 0.0, 2025.0)
    Fe = math.sqrt(Xe * Xe + Ye * Ye + Ze * Ze)
    Fp = math.sqrt(Xp * Xp + Yp * Yp + Zp * Zp)
    # 楕円体なので極はわずかに地心に近く、比は2.00でなく2.02になる
    ok(abs(Fp / Fe - 2.02) < 0.02, f'dipole: polar field is ~twice the equatorial one ({Fp/Fe:.3f})')
    ok(Xe > 0 and abs(Ze) < abs(Xe) * 0.01,
       'dipole at the equator points north with no vertical component')
    ok(Zp > 0 and abs(Xp) < abs(Zp) * 0.01,
       'dipole at the north pole points straight down')

    # ② 傾いたダイポール(h11を足す): 偏角が経度で符号を変える。
    #    h11 だけなら経度±90°がゼロ点、0°と180°が極値になる
    tilt = G.load_wmm(cof(['  1  0  -30000.0       0.0        0.0        0.0',
                           '  1  1       0.0    5000.0        0.0        0.0']))
    d0 = G.wmm_declination(tilt, 0.0, 0.0, 0.0, 2025.0)
    d180 = G.wmm_declination(tilt, 0.0, 180.0, 0.0, 2025.0)
    dnull = G.wmm_declination(tilt, 0.0, 90.0, 0.0, 2025.0)
    ok(abs(d0) > 1.0, f'a tilted dipole produces a real declination ({d0:.2f}°)')
    ok(d0 * d180 < 0 and abs(abs(d0) - abs(d180)) < 1e-6,
       'declination is antisymmetric across opposite meridians')
    ok(abs(dnull) < 1e-9, 'an h11-only tilt has its null meridian at ±90°')

    # ③ 永年変化: dg が効いて時間で動く
    sv = G.load_wmm(cof(['  1  0  -30000.0       0.0        0.0        0.0',
                         '  1  1       0.0    5000.0        0.0      500.0']))
    s0 = G.wmm_declination(sv, 35.0, 139.0, 0.0, 2025.0)
    s5 = G.wmm_declination(sv, 35.0, 139.0, 0.0, 2030.0)
    ok(abs(s5 - s0) > 0.5, f'secular variation moves the declination over 5 years ({s0:.2f}° → {s5:.2f}°)')

    # ④ 高度で値が変わる(球面調和の r 依存が効いている)
    a0 = G.wmm_field(tilt, 35.0, 139.0, 0.0, 2025.0)
    a100 = G.wmm_field(tilt, 35.0, 139.0, 100.0, 2025.0)
    ok(abs(a100[0]) < abs(a0[0]), 'field weakens with altitude')

    # ⑤ .zip のまま読める / 9999終端を係数として拾わない
    import zipfile
    zp = os.path.join(td, 'w.zip')
    with zipfile.ZipFile(zp, 'w') as z:
        z.write(cof(['  1  0  -30000.0       0.0        0.0        0.0']), 'WMM.COF')
    zc = G.load_wmm(zp)
    ok(zc['epoch'] == 2025.0 and zc['N'] == 1 and len(zc['g']) == 1,
       'load_wmm reads a .zip and ignores the 9999 terminator')

    # ⑥ CLI: --dec は --wmm を上書きする / 有効期間外は警告する
    gpx = os.path.join(td, 'r.gpx'); make_gpx(gpx)
    real = cof(['  1  0  -30000.0       0.0        0.0        0.0',
                '  1  1   -1500.0    4500.0        0.0        0.0'])
    dump = os.path.join(td, 'o.json')
    r = run([gpx, '--id', 'w', '--name', 'W', '--wmm', real, '--date', '2026-06-01', '--dump-json', dump])
    ok(r.returncode == 0 and '偏角: WMM2025' in r.stderr, 'stderr reports the computed declination')
    auto = json.load(open(dump, encoding='utf-8'))['dec']
    ok(auto != 7.5, f'declination comes from the model, not the hardcoded default ({auto})')

    r = run([gpx, '--id', 'w', '--name', 'W', '--wmm', real, '--date', '2026-06-01',
             '--dec', '6.25', '--dump-json', dump])
    ok(json.load(open(dump, encoding='utf-8'))['dec'] == 6.25, '--dec overrides the model value')
    ok('WMMの算出値を上書き' in r.stderr, 'the override is reported, not silent')

    r = run([gpx, '--id', 'w', '--name', 'W', '--wmm', real, '--date', '2034-01-01'])
    ok('有効期間' in r.stderr, 'a date outside the model validity window is flagged')

    r = run([gpx, '--id', 'w', '--name', 'W', '--dump-json', dump])
    ok(json.load(open(dump, encoding='utf-8'))['dec'] == 7.5, 'without --wmm the 7.5 default still applies')

    r = run(['--emit-wmm-fetch'])
    ok(r.returncode == 0 and 'ncei.noaa.gov' in r.stdout and 'TEST_VALUES' in r.stdout,
       'emit-wmm-fetch prints both the coefficients and the official test values')

# ---- v3.2: 道路グラフ上のルーティング(--route-osm) ----
# 概形は道の無い場所を通り得るので「吸着」では直らない。経由点を道路グラフの最短経路で
# 結べば結果は定義上100%道の上。碁盤目の街路に円形の概形を置いて確かめる
print('[route-osm]')
with tempfile.TemporaryDirectory() as td:
    LA0, LO0 = 35.00, 139.00
    KX = 111320.0 * math.cos(math.radians(LA0)); KY = 110540.0
    def way(i, t, l): return {'type': 'way', 'id': i, 'tags': t, 'geometry': [{'lat': a, 'lon': b} for (a, b) in l]}
    els, wid = [], 1
    for k in range(-3, 4):                       # 200m 間隔の碁盤目(±600m)
        y = LA0 + k * 200.0 / KY; x = LO0 + k * 200.0 / KX
        els.append(way(wid, {'highway': 'residential'}, [(y, LO0 + j * 200.0 / KX) for j in range(-3, 4)])); wid += 1
        els.append(way(wid, {'highway': 'residential'}, [(LA0 + j * 200.0 / KY, x) for j in range(-3, 4)])); wid += 1
    # 中央を貫く高速道路(吸着・経路の候補から外れるべき)
    els.append(way(wid, {'highway': 'motorway'}, [(LA0 + 5.0 / KY, LO0 + j * 200.0 / KX) for j in range(-3, 4)]))
    osm = os.path.join(td, 'grid.json'); json.dump({'elements': els}, open(osm, 'w'))
    ways = G.load_osm_ways([osm])
    # 概形: 半径 300m の円(格子の上には乗っていない)
    circ = [(LA0 + 300.0 * math.cos(t) / KY, LO0 + 300.0 * math.sin(t) / KX, 5.0)
            for t in [i * 2 * math.pi / 36 for i in range(37)]]
    out, st = G.route_on_graph(circ, ways, 'urban', 150.0, 300.0)
    ok(st['ok'] > 0 and st['skipped'] == 0, f'every via point is joined by a road path ({st["ok"]} legs)')
    # 全点が格子の上(いずれかの街路線分から 1m 以内)
    segs = []
    lat0 = circ[0][0]
    for (k, cls, line, sub, _tags) in ways:
        if k != 'road' or sub in G.SNAP_EXCLUDE: continue
        for i in range(1, len(line)):
            segs.append((G._xy((line[i-1][0], line[i-1][1], 0), lat0), G._xy((line[i][0], line[i][1], 0), lat0), 0, 0.0))
    idx = G.SegIndex(segs)
    worst = 0.0
    for p in G.densify(out, 5.0):
        c = idx.candidates(G._xy(p, lat0), 50.0, 1, None, -1.0)
        worst = max(worst, c[0][0] if c else 50.0)
    ok(worst < 1.0, f'the routed line lies on the streets everywhere (max {worst:.2f}m off)')
    # 高速道路(motorway)は使わない
    on_mw = 0
    for p in G.densify(out, 5.0):
        xm = (p[1] - LO0) * KX
        on_vertical = min(abs(xm - k * 200.0) for k in range(-3, 4)) < 1.0    # 縦の街路との交点は除く
        if abs((p[0] - LA0) * KY - 5.0) < 0.5 and abs(xm) < 580 and not on_vertical: on_mw += 1
    ok(on_mw == 0, 'the motorway through the middle is never used')
    L = G.cumdist(out)[-1]
    ok(1600 < L < 2600, f'a 300m-radius loop on a 200m grid comes out around 2km ({L:.0f}m)')
    # 道の無い場所: グラフに何も乗せられなければ原ジオメトリを返す(嘘の道を作らない)
    far = [(LA0 + 0.05, LO0 + 0.05, 5.0), (LA0 + 0.051, LO0 + 0.05, 5.0)]
    out2, st2 = G.route_on_graph(far, ways, 'urban', 100.0, 300.0)
    ok(st2['ok'] == 0 and out2 == far, 'with no road within reach nothing is invented')
    # 囲む閉路: 格子のセル内の点を囲む最短の閉路は 1セル(200m×4=800m)。ラン重み表で residential を優先
    ring, rst = G.enclosing_loop(ways, (LA0 + 50.0 / KY, LO0 + 50.0 / KX), 'urban', r_min=50.0, r_max=1000.0, prefer=('residential',))
    ok(ring is not None and abs(rst['len'] - 800.0) < 5.0, f'enclosing loop around a cell point is that cell ({rst.get("len", 0):.0f}m)')
    ring2 = G.orient_loop(ring, (LA0 + 50.0 / KY, LO0 - 50.0 / KX, 0.0), ccw=True) if ring else None
    okc = ring2 is not None and G.hav(ring2[0], ring2[-1]) < 1
    if okc:
        rxy = [G._xy(p, LA0) for p in ring2]
        okc = sum(rxy[i - 1][0] * rxy[i][1] - rxy[i][0] * rxy[i - 1][1] for i in range(len(rxy))) > 0
    ok(okc, 'orient_loop closes the ring and makes it counter-clockwise')
    # ラン重み表: 通行禁止・歩道の無い trunk・駐車場通路は使わない / 歩道タグ付き車道は受け皿
    ok(G.run_weight('footway', {'foot': 'no'}, G.STREET_W) is None, 'foot=no is excluded')
    ok(G.run_weight('service', {'access': 'private'}, G.STREET_W) is None, 'access=private is excluded')
    ok(G.run_weight('trunk', {}, G.STREET_W) is None and G.run_weight('trunk', {'sidewalk': 'both'}, G.STREET_W) == 1.1,
       'trunk needs a sidewalk tag; tagged carriageways cost 1.1')
    ok(G.run_weight('service', {'service': 'parking_aisle'}, G.STREET_W) == 3.0, 'parking aisles cost 3.0')
    ok(G.run_weight('path', {'surface': 'gravel'}, G.STREET_W) == 1.4 and G.run_weight('steps', {}, G.STREET_W) == 5.0,
       'unpaved path 1.4 / steps 5.0')

# ---- 都市デモ(晴海・皇居)は OSM の実在道路の上だけを通ること ----
# 手描きの概形は岸壁や濠の上を通っていた(SPEC A-3 実測)。make_field_demo.py が角を数点指定して
# 道路網の最短路で結ぶ方式に変えたので、生成物 routes.js をそのまま検証する
print('[demo on OSM]')
def _dec_poly(s):
    out, i, la, lo = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _w in (0, 1):
            r = sh = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            vals.append(~(r >> 1) if r & 1 else r >> 1)
        la += vals[0]; lo += vals[1]
        out.append((la / 1e5, lo / 1e5, 0.0))
    return out
_rjs = open(os.path.join(TOOLS, '..', 'src', 'routes.js'), encoding='utf-8').read()
_routes = {r['id']: r for r in json.loads(_rjs.split('var ROUTES = ', 1)[1].strip().rstrip(';'))}
# 皇居は公式約5.0km(反時計回り・内側の歩道リング)。角を門に置いた版は 5.7km で外苑側に膨らんでいた
for _rid, _fx, _lo, _hi in (('kokyo', 'kokyo-osm.json', 4850, 5150), ('harumi', 'harumi-osm.json', 1400, 2000)):
    _fxp = os.path.join(TOOLS, '..', 'test', 'fixtures', _fx)
    if _rid not in _routes or not os.path.exists(_fxp):
        ok(False, f'{_rid}: route or fixture missing'); continue
    _r = _routes[_rid]; _pts = _dec_poly(_r['poly']); _lat0 = _pts[0][0]
    _segs = []
    for _el in json.load(open(_fxp, encoding='utf-8'))['elements']:
        _t = _el.get('tags') or {}; _g = _el.get('geometry')
        if not _g or not _t.get('highway') or _t['highway'].startswith('motorway'): continue
        _line = [G._xy((q['lat'], q['lon'], 0), _lat0) for q in _g]
        _segs += [(_line[k - 1], _line[k], 0, 0.0) for k in range(1, len(_line))]
    _idx = G.SegIndex(_segs)
    _dense = []
    for k in range(1, len(_pts)):
        _n = max(1, int(G.hav(_pts[k - 1], _pts[k]) / 10))
        _dense += [(_pts[k - 1][0] + (_pts[k][0] - _pts[k - 1][0]) * j / _n,
                    _pts[k - 1][1] + (_pts[k][1] - _pts[k - 1][1]) * j / _n, 0) for j in range(_n)]
    _far = [c[0][0] if c else 99.0 for c in (_idx.candidates(G._xy(p, _lat0), 30.0, 1, None, -1.0) for p in _dense)]
    ok(max(_far) < 5.0, f'{_rid}: every 10m sample lies on an OSM road (max {max(_far):.1f}m off)')
    ok(_lo < _r['dist'] < _hi, f'{_rid}: length {_r["dist"]}m is the real loop ({_lo}-{_hi})')
    ok(G.hav(_pts[0], _pts[-1]) < 1.0, f'{_rid}: closed loop')
    _spur = 0
    for k in range(1, len(_pts) - 1):
        a, b, c = (G._xy(_pts[k - 1], _lat0), G._xy(_pts[k], _lat0), G._xy(_pts[k + 1], _lat0))
        v1, v2 = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        cs = (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2) + 1e-9)
        if cs > math.cos(math.radians(20)): _spur += 1
    ok(_spur == 0, f'{_rid}: no out-and-back spurs (<20° turns: {_spur})')
    ok('vec' in _r and len(_r['vec'].get('road', [])) > 50, f'{_rid}: map vectors baked from the same OSM data')
    ok(all(0 < w['d'] < _r['dist'] for w in _r['wps'][1:-1]), f'{_rid}: intermediate WPs sit inside the loop')
    _xyr = [G._xy(p, _lat0) for p in _pts]
    _area = sum(_xyr[k - 1][0] * _xyr[k][1] - _xyr[k][0] * _xyr[k - 1][1] for k in range(len(_xyr)))
    ok(_area > 0, f'{_rid}: counter-clockwise (left side faces the block/palace)')
    _crossing = 0; _seen = set()
    _cidx = {}
    for _el in json.load(open(_fxp, encoding='utf-8'))['elements']:
        _t = _el.get('tags') or {}
        if _t.get('footway') == 'crossing' and _el.get('geometry'):
            _cidx[_el['id']] = [G._xy((q['lat'], q['lon'], 0), _lat0) for q in _el['geometry']]
    _csegs = [(l[k - 1], l[k], i, 0.0) for i, l in _cidx.items() for k in range(1, len(l))]
    _ci = G.SegIndex(_csegs) if _csegs else None
    for p in _dense:
        for c in (_ci.candidates(G._xy(p, _lat0), 4.0, 3, None, -1.0) if _ci else []):
            if c[2] not in _seen: _seen.add(c[2]); _crossing += 1
    ok(_crossing <= (20 if _rid == 'kokyo' else 6), f'{_rid}: few street crossings ({_crossing}; signals/crossings are penalised)')

# ---- その場モード: app.js の FAMOUS は gpx2route.py の FAMOUS と同一であること ----
print('[famous sync]')
import re as _re
_src = open(os.path.join(TOOLS, '..', 'src', 'app.js'), encoding='utf-8').read()
_m = _re.search(r'var FAMOUS = \[(.*?)\n  \];', _src, _re.S)
_rows = _re.findall(r"\['([^']+)',([\d.]+),([\d.]+),(\d+)\]", _m.group(1)) if _m else []
_app = {n: (float(la), float(lo), int(el)) for n, la, lo, el in _rows}
_py = {n: (la, lo, el) for (n, la, lo, el) in G.FAMOUS}
ok(len(_app) == len(_py) and len(_app) > 40, f'app.js FAMOUS has the same {len(_py)} peaks as gpx2route.py')
_diff = [n for n in _py if n not in _app or any(abs(a - b) > 1e-6 for a, b in zip(_app[n], _py[n]))]
ok(not _diff, 'every peak matches by name, position and elevation' + (f' (mismatch: {_diff[:3]})' if _diff else ''))

print(f"\n{STEP[0] - len(FAILS)}/{STEP[0]} passed")
sys.exit(1 if FAILS else 0)
