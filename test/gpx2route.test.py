#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gpx2route.py v3 の機械検証。合成GPX+偽Overpass JSONで
   emit-query / OSM分類・距離フィルタ / 著名峰マージ / vis / seg / domain判定を踏む。"""
import json, os, subprocess, sys, tempfile

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

print(f"\n{STEP[0] - len(FAILS)}/{STEP[0]} passed")
sys.exit(1 if FAILS else 0)
