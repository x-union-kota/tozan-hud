#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gpx2route.py — GPX を 登山HUD の同梱ルート形式(JSオブジェクト)に変換する。
v3: OSM POI(温泉/駅/小屋 等)・山座レジストリ・区間ボス・偏角・ドメインを焼き込む。

── ワークフロー(コンテナに外部ネットワークが無い前提のオフライン2段構え) ──

  ① クエリ生成(このスクリプト) → ② Overpassで実行(手元のブラウザ/curl) → ③ 変換(このスクリプト)

  # ① GPXのbboxからOverpass QLクエリを出力
  python3 gpx2route.py input.gpx --emit-query > query.txt

  # ② query.txt の中身を https://overpass-api.de/api/interpreter に投げ、
  #    応答JSONを poi.json として保存(curl例はクエリ末尾のコメントに出力される)

  # ③ 変換。reg/segs/dec/domain 込みの v3 ルートオブジェクトを出力
  python3 gpx2route.py input.gpx --id yari --name "槍ヶ岳 上高地ルート" \\
      --osm poi.json \\
      --seg "0.10-0.25:明神までの樹林帯" --seg "12000-15500:槍沢の登り" \\
      --vis "富士山,穂高岳" --dec 7.7 > route.js

出力を index.html / routes.js の ROUTES 配列に貼り付ける。

── 形式 ──
  poly : Google polyline (precision 1e-5, ~1m) で lat/lng を差分圧縮
  ele  : 同じ差分アルゴリズムの1次元版 (precision 1m)
  wps  : GPX の <wpt> をルート上の沿道距離(m)にスナップしたもの
         type は wpt の <type> か <cmt> から拾う (water/hut/junction/peak/escape/start/goal)
  cts  : [[沿道距離m, 標準CT累積分], ...]  --ct で与えるか、無指定なら
         標準式(登り300m/h+水平4km/h, 下り500m/h+水平4.5km/h)で自動生成
  reg  : 山座同定レジストリ [{n,la,lo,el,t,v}] — OSM+内蔵著名峰DBから生成
  segs : 区間ボス [{a,b,n}] — --seg の手動指定
  dec  : 磁気偏角(西偏を正)。--dec で指定(地理院の管区値を手で引く)
  domain: 'mountain' | 'urban'。--domain auto なら獲得標高/kmで自動判定

── 可視判定の方針(重要) ──
  DEMレイキャスト無しで「見える」と断言しない。OSM由来の対象はすべて v:0(破線=透視)。
  実線(v:1)にするのは --vis で名指しした手動確証のみ。アプリの正直さゲートと同じ思想。
"""
import argparse, json, math, re, sys, xml.etree.ElementTree as ET

R = 6371000.0

def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dla, dlo = la2 - la1, lo2 - lo1
    h = math.sin(dla/2)**2 + math.cos(la1)*math.cos(la2)*math.sin(dlo/2)**2
    return 2*R*math.asin(math.sqrt(h))

# ---------- Douglas-Peucker (equirectangular近似, m単位) ----------
def _xy(p, lat0):
    k = math.cos(math.radians(lat0))
    return (p[1]*k*111320.0, p[0]*110540.0)

def _pseg(p, a, b):
    px,py = p; ax,ay = a; bx,by = b
    dx,dy = bx-ax, by-ay
    L2 = dx*dx+dy*dy
    if L2 == 0: return math.hypot(px-ax, py-ay)
    t = max(0.0, min(1.0, ((px-ax)*dx+(py-ay)*dy)/L2))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))

def simplify(pts, tol):
    if len(pts) < 3: return pts[:]
    lat0 = pts[0][0]
    xy = [_xy(p, lat0) for p in pts]
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts)-1)]
    while stack:
        i, j = stack.pop()
        if j <= i+1: continue
        dmax, k = -1.0, -1
        for m in range(i+1, j):
            d = _pseg(xy[m], xy[i], xy[j])
            if d > dmax: dmax, k = d, m
        if dmax > tol:
            keep[k] = True
            stack += [(i,k),(k,j)]
    return [p for p,f in zip(pts,keep) if f]

# ---------- polyline encode ----------
def _enc(v, out):
    v = v << 1 if v >= 0 else ~(v << 1)
    while v >= 0x20:
        out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
    out.append(chr(v + 63))

def enc_poly(pts):
    out, pla, plo = [], 0, 0
    for p in pts:
        la, lo = round(p[0]*1e5), round(p[1]*1e5)
        _enc(la-pla, out); _enc(lo-plo, out)
        pla, plo = la, lo
    return ''.join(out)

def enc_ele(pts):
    out, pe = [], 0
    for p in pts:
        e = round(p[2])
        _enc(e-pe, out); pe = e
    return ''.join(out)

# ---------- profile ----------
def cumdist(pts):
    d = [0.0]
    for i in range(1, len(pts)):
        d.append(d[-1] + hav(pts[i-1], pts[i]))
    return d

def total_gain(pts):
    g = 0.0
    for i in range(1, len(pts)):
        de = pts[i][2]-pts[i-1][2]
        if de > 0: g += de
    return g

def auto_ct(pts, cum, step=500.0):
    """標準式でCT累積(分)を step(m) ごとにサンプル"""
    t, out, nxt = 0.0, [[0,0]], step
    for i in range(1, len(pts)):
        dd = cum[i]-cum[i-1]
        de = pts[i][2]-pts[i-1][2]
        up = max(de,0); dn = max(-de,0)
        t += (dd/4000.0 + up/300.0)*60 if de >= 0 else (dd/4500.0 + dn/500.0)*60
        while cum[i] >= nxt:
            out.append([round(nxt), round(t, 1)])
            nxt += step
    out.append([round(cum[-1]), round(t,1)])
    return out

def parse_ct(s, total):
    cts = [[int(a), float(b)] for a,b in (x.split(':') for x in s.split(','))]
    if cts[0][0] != 0: cts.insert(0,[0,0])
    if cts[-1][0] < total: cts.append([round(total), cts[-1][1]])
    return cts

# ---------- GPX ----------
def strip_ns(t): return re.sub(r'\{.*\}', '', t)

def load_gpx(path):
    root = ET.parse(path).getroot()
    trk, wps = [], []
    for el in root.iter():
        tag = strip_ns(el.tag)
        if tag == 'trkpt' or tag == 'rtept':
            ele = 0.0
            for c in el:
                if strip_ns(c.tag) == 'ele': ele = float(c.text)
            trk.append((float(el.get('lat')), float(el.get('lon')), ele))
        elif tag == 'wpt':
            name, typ = '', ''
            for c in el:
                t2 = strip_ns(c.tag)
                if t2 == 'name': name = (c.text or '').strip()
                if t2 in ('type','cmt') and not typ: typ = (c.text or '').strip().lower()
            wps.append((float(el.get('lat')), float(el.get('lon')), name, typ))
    return trk, wps

def snap_wp(wp, pts, cum):
    best, bd = 0, 1e18
    for i,p in enumerate(pts):
        d = hav((wp[0],wp[1]), p)
        if d < bd: bd, best = d, i
    return round(cum[best])

# ---------- v3: 内蔵著名峰DB(遠景の実線候補。OSMのbbox外もカバー) ----------
FAMOUS = [
 ('富士山',35.3606,138.7274,3776),('北岳',35.6745,138.2389,3193),('奥穂高岳',36.2894,137.6480,3190),
 ('槍ヶ岳',36.3420,137.6476,3180),('御嶽山',35.8930,137.4800,3067),('乗鞍岳',36.1060,137.5540,3026),
 ('立山',36.5730,137.6180,3015),('白馬岳',36.7580,137.7580,2932),('甲斐駒ヶ岳',35.7580,138.2370,2967),
 ('仙丈ヶ岳',35.7200,138.1830,3033),('八ヶ岳(赤岳)',35.9706,138.3703,2899),('浅間山',36.4060,138.5230,2568),
 ('金峰山',35.8720,138.6280,2599),('雲取山',35.8556,138.9439,2017),('男体山',36.7650,139.4910,2486),
 ('谷川岳',36.8340,138.9300,1977),('赤城山',36.5600,139.1930,1828),('筑波山',36.2250,140.1060,877),
 ('丹沢山',35.4750,139.1620,1567),('大山(丹沢)',35.4400,139.2320,1252),('高尾山',35.6252,139.2436,599),
 ('大岳山',35.7610,139.1220,1266),('御岳山(奥多摩)',35.7830,139.1490,929),('箱根山(神山)',35.2330,139.0210,1438),
 ('天城山',34.8640,139.0060,1406),('大台ヶ原山',34.1860,136.1080,1695),('大峰山(八経ヶ岳)',34.1680,135.9070,1915),
 ('石鎚山',33.7670,133.1150,1982),('剣山',33.8530,134.0940,1955),('阿蘇山(高岳)',32.8840,131.1040,1592),
 ('九重山(中岳)',33.0860,131.2490,1791),('桜島(御岳)',31.5850,130.6570,1117),('開聞岳',31.1800,130.5280,924),
 ('大山(伯耆)',35.3710,133.5460,1729),('岩木山',40.6560,140.3030,1625),('岩手山',39.8530,141.0010,2038),
 ('鳥海山',39.0990,140.0490,2236),('月山',38.5490,140.0270,1984),('磐梯山',37.6010,140.0720,1816),
 ('那須岳(茶臼岳)',37.1250,139.9630,1915),('妙高山',36.8910,138.1130,2454),('白山',36.1550,136.7710,2702),
]

# ---------- v3: OSM(Overpass JSON)入力 ----------
# タグ → HUD type の分類。順序が優先度(先にマッチしたものが勝つ)
OSM_CLASSIFY = [
    ('peak',   lambda t: t.get('natural') in ('peak', 'volcano')),
    ('onsen',  lambda t: t.get('amenity') == 'public_bath' or t.get('natural') == 'hot_spring'
                         or t.get('bath:type') == 'onsen' or t.get('leisure') == 'spa'),
    ('sta',    lambda t: t.get('railway') == 'station' or t.get('public_transport') == 'station'),
    ('hut',    lambda t: t.get('tourism') in ('alpine_hut', 'wilderness_hut')
                         or (t.get('amenity') == 'shelter' and t.get('shelter_type') in ('basic_hut', 'weather_shelter'))),
    ('shrine', lambda t: t.get('amenity') == 'place_of_worship' or t.get('historic') == 'shrine'),
    ('shop',   lambda t: t.get('amenity') in ('restaurant', 'cafe') or t.get('tourism') == 'viewpoint'),
    ('tower',  lambda t: t.get('man_made') == 'tower' and t.get('tower:type') in ('communication', 'observation')),
]
DEFAULT_POI_TYPES = 'onsen,sta,hut,shrine'   # shop/tower は明示オプトイン(都市部で溢れるため)

def parse_ele(tags, fallback):
    try:
        return round(float(re.sub(r'[^\d.\-]', '', str(tags.get('ele')))))
    except (TypeError, ValueError):
        return fallback

def load_osm(paths):
    """Overpass JSON(複数可)→ [(name, la, lo, typ, ele|None)]。way/relation は out center 前提。"""
    out, seen_ids = [], set()
    for path in paths:
        data = json.load(open(path, encoding='utf-8'))
        for el in data.get('elements', []):
            key = (el.get('type'), el.get('id'))
            if key in seen_ids: continue
            seen_ids.add(key)
            tags = el.get('tags') or {}
            name = tags.get('name:ja') or tags.get('name')
            if not name: continue                       # 無名対象はHUDに出しても意味がない
            if 'lat' in el: la, lo = el['lat'], el['lon']
            elif 'center' in el: la, lo = el['center']['lat'], el['center']['lon']
            else: continue
            typ = next((t for t, f in OSM_CLASSIFY if f(tags)), None)
            if typ is None: continue
            out.append((name.strip(), la, lo, typ, parse_ele(tags, None)))
    return out

def min_dist_to_route(p, xy_pts, lat0):
    """点pからルート折れ線への最短距離(m)"""
    q = _xy(p, lat0)
    best = 1e18
    for i in range(1, len(xy_pts)):
        d = _pseg(q, xy_pts[i-1], xy_pts[i])
        if d < best: best = d
    return best

def route_ele_near(p, pts):
    best, be = 1e18, 0
    for pt in pts:
        d = hav(p, pt)
        if d < best: best, be = d, pt[2]
    return round(be)

def build_reg(pts, osm_items, poi_types, poi_radius, peak_km, vis_names, max_reg):
    lat0 = pts[0][0]
    xy_pts = [_xy(p, lat0) for p in pts]
    cla, clo = sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts)
    visset = set(vis_names)
    reg, names_at = [], []   # names_at: (name, la, lo) 近接重複排除用

    def dup(name, la, lo):
        for (n2, la2, lo2) in names_at:
            if n2 == name or hav((la, lo), (la2, lo2)) < 300 and n2[:2] == name[:2]:
                return True
        return False

    def add(name, la, lo, el, typ, sort_key):
        if dup(name, la, lo): return
        names_at.append((name, la, lo))
        reg.append({'n': name, 'la': round(la, 5), 'lo': round(lo, 5), 'el': el,
                    't': typ, 'v': 1 if name in visset else 0, '_s': sort_key})

    peaks, pois = [], []
    for (name, la, lo, typ, ele) in osm_items:
        if typ == 'peak':
            d_km = hav((la, lo), (cla, clo)) / 1000.0
            if d_km <= peak_km or name in visset:
                peaks.append((name, la, lo, ele if ele is not None else 0, d_km))
        elif typ in poi_types:
            d = min_dist_to_route((la, lo, 0), xy_pts, lat0)
            if d <= poi_radius:
                ele2 = ele if ele is not None else route_ele_near((la, lo, 0), pts)
                pois.append((name, la, lo, ele2, typ, d))

    # 内蔵著名峰: 150km圏で合流(近距離30km超は --vis 指定時のみ)。OSM側と名前重複ならOSM座標を優先
    for (name, la, lo, ele) in FAMOUS:
        d_km = hav((la, lo), (cla, clo)) / 1000.0
        if d_km > 150: continue
        if d_km > peak_km and name not in visset: continue
        if any(p[0] == name for p in peaks): continue
        peaks.append((name, la, lo, ele, d_km))

    # 優先度: 峰は標高降順(遠景の目印価値)、POIはルートからの近さ
    for (name, la, lo, ele, d_km) in sorted(peaks, key=lambda x: -x[3]):
        add(name, la, lo, ele, 'peak', -ele)
    for (name, la, lo, ele, typ, d) in sorted(pois, key=lambda x: x[5]):
        add(name, la, lo, ele, typ, d)

    dropped = 0
    if len(reg) > max_reg:
        # 峰は上位を残し、POIは近い順に残す(既にその順で並んでいる)
        dropped = len(reg) - max_reg
        reg = reg[:max_reg]
    for r in reg: del r['_s']
    return reg, dropped

# ---------- v3: 区間ボス手動指定 ----------
def parse_segs(specs, total):
    """"a-b:名前" のリスト。a,b は 0〜1 なら割合、それ以外は沿道距離m。"""
    segs = []
    for spec in specs:
        m = re.match(r'^\s*([\d.]+)\s*-\s*([\d.]+)\s*:\s*(.+?)\s*$', spec)
        if not m: sys.exit(f'--seg の書式エラー: "{spec}" (例: "0.08-0.22:金比羅台の登り" / "1200-3400:○○の登り")')
        a, b, name = float(m.group(1)), float(m.group(2)), m.group(3)
        if a <= 1.0 and b <= 1.0: a, b = a*total, b*total
        if not (0 <= a < b <= total + 1):
            sys.exit(f'--seg 範囲エラー: "{spec}" (0 ≤ a < b ≤ {round(total)}m)')
        segs.append({'a': round(a), 'b': round(b), 'n': name})
    segs.sort(key=lambda s: s['a'])
    for i in range(1, len(segs)):
        if segs[i]['a'] < segs[i-1]['b']:
            sys.exit(f"--seg 区間が重複: {segs[i-1]['n']} と {segs[i]['n']}")
    return segs

# ---------- v3: Overpassクエリ生成 ----------
def emit_query(pts, poi_radius, peak_km):
    las = [p[0] for p in pts]; los = [p[1] for p in pts]
    mgn_poi = (poi_radius + 500) / 110540.0
    k = math.cos(math.radians(sum(las)/len(las)))
    mgn_poi_lo = (poi_radius + 500) / (111320.0 * k)
    mgn_pk = peak_km * 1000 / 110540.0
    mgn_pk_lo = peak_km * 1000 / (111320.0 * k)
    bb_poi = f"{min(las)-mgn_poi:.4f},{min(los)-mgn_poi_lo:.4f},{max(las)+mgn_poi:.4f},{max(los)+mgn_poi_lo:.4f}"
    bb_pk  = f"{min(las)-mgn_pk:.4f},{min(los)-mgn_pk_lo:.4f},{max(las)+mgn_pk:.4f},{max(los)+mgn_pk_lo:.4f}"
    q = f"""[out:json][timeout:120];
(
  node["natural"~"^(peak|volcano)$"]["name"]({bb_pk});
  node["amenity"="public_bath"]({bb_poi});
  node["natural"="hot_spring"]({bb_poi});
  nwr["leisure"="spa"]({bb_poi});
  node["railway"="station"]({bb_poi});
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]({bb_poi});
  node["amenity"="shelter"]["shelter_type"~"^(basic_hut|weather_shelter)$"]({bb_poi});
  nwr["amenity"="place_of_worship"]({bb_poi});
);
out center;
// 実行例: curl -sG https://overpass-api.de/api/interpreter --data-urlencode data@query.txt > poi.json
// bbox: POI近傍={bb_poi} / 山頂={bb_pk} ({peak_km}km圏)
// shop/tower も欲しい場合は該当行を足す(都市部では件数が溢れるので既定では出さない)"""
    print(q)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('gpx')
    ap.add_argument('--id'); ap.add_argument('--name')
    ap.add_argument('--tol', type=float, default=6.0, help='簡略化許容誤差 m')
    ap.add_argument('--ct', default=None, help='"沿道距離m:累積CT分" のカンマ列。無指定は標準式で自動')
    # v3
    ap.add_argument('--emit-query', action='store_true', help='Overpass QLクエリを出力して終了(手元で実行→--osmで投入)')
    ap.add_argument('--osm', action='append', default=[], help='Overpass応答JSON(複数可)')
    ap.add_argument('--poi-types', default=DEFAULT_POI_TYPES, help=f'採用POI種別 (既定: {DEFAULT_POI_TYPES})')
    ap.add_argument('--poi-radius', type=float, default=1500, help='POI採用: ルートからの距離 m (既定1500)')
    ap.add_argument('--peak-km', type=float, default=30, help='山頂採用: ルート重心からの距離 km (既定30。超は--vis指定のみ)')
    ap.add_argument('--vis', default='', help='実線(可視確証)にする対象名のカンマ列。指定なし=全て破線(透視)')
    ap.add_argument('--seg', action='append', default=[], help='区間ボス "a-b:名前" (a,b: 0〜1=割合 / それ以外=m。複数可)')
    ap.add_argument('--dec', type=float, default=7.5, help='磁気偏角(西偏+)。地理院の管区値を指定 (既定7.5)')
    ap.add_argument('--domain', default='auto', choices=['auto', 'mountain', 'urban'])
    ap.add_argument('--max-reg', type=int, default=80, help='regの上限件数 (既定80)')
    ap.add_argument('--dump-json', default=None, help='(検証用) 厳密JSONも書き出す')
    a = ap.parse_args()

    trk, wraw = load_gpx(a.gpx)
    if len(trk) < 2: sys.exit('trkpt がありません')
    pts = simplify(trk, a.tol)

    if a.emit_query:
        emit_query(pts, a.poi_radius, a.peak_km)
        return
    if not a.id or not a.name: sys.exit('--id と --name は必須です(--emit-query 時を除く)')

    cum = cumdist(pts)
    total, gain = cum[-1], total_gain(pts)
    cts = parse_ct(a.ct, total) if a.ct else auto_ct(pts, cum)
    wps = [{'d': snap_wp(w, pts, cum), 'n': w[2] or f'WP{i+1}', 't': w[3] or 'wp'}
           for i,w in enumerate(wraw)]
    wps.sort(key=lambda w: w['d'])

    vis_names = [v.strip() for v in a.vis.split(',') if v.strip()]
    poi_types = set(t.strip() for t in a.poi_types.split(',') if t.strip())
    osm_items = load_osm(a.osm) if a.osm else []
    reg, dropped = build_reg(pts, osm_items, poi_types, a.poi_radius, a.peak_km, vis_names, a.max_reg)
    missing_vis = [v for v in vis_names if not any(r['n'] == v for r in reg)]
    segs = parse_segs(a.seg, total)
    domain = a.domain if a.domain != 'auto' else ('urban' if gain / max(total/1000, 0.1) < 15 else 'mountain')

    obj = (f"{{id:'{a.id}',name:'{a.name}',dist:{round(total)},gain:{round(gain)},"
           f"poly:'{enc_poly(pts)}',ele:'{enc_ele(pts)}',"
           f"wps:{json.dumps(wps, ensure_ascii=False, separators=(',',':'))},"
           f"cts:{json.dumps([[c[0],round(c[1])] for c in cts], separators=(',',':'))},"
           f"reg:{json.dumps(reg, ensure_ascii=False, separators=(',',':'))},"
           f"segs:{json.dumps(segs, ensure_ascii=False, separators=(',',':'))},"
           f"dec:{a.dec},domain:'{domain}'}}")
    sys.stderr.write(f"点数 {len(trk)}→{len(pts)} / 距離 {total/1000:.1f}km / 獲得 {gain:.0f}m / domain {domain}\n"
                     f"reg {len(reg)}件 (峰{sum(1 for r in reg if r['t']=='peak')} POI{sum(1 for r in reg if r['t']!='peak')}"
                     f"{f' / 上限超過{dropped}件を切り捨て' if dropped else ''}) / segs {len(segs)} / サイズ約 {len(obj)/1024:.1f}KB\n")
    if missing_vis:
        sys.stderr.write(f"⚠ --vis 指定がregに見つからない: {', '.join(missing_vis)} (綴りを確認)\n")
    if a.osm and not osm_items:
        sys.stderr.write("⚠ OSM JSONから対象が1件も取れていない(クエリ/ファイルを確認)\n")
    if a.dump_json:
        full = {'id': a.id, 'name': a.name, 'dist': round(total), 'gain': round(gain),
                'wps': wps, 'reg': reg, 'segs': segs, 'dec': a.dec, 'domain': domain}
        json.dump(full, open(a.dump_json, 'w', encoding='utf-8'), ensure_ascii=False)
    print(obj + ',')

if __name__ == '__main__':
    main()
