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
  「見える」と断言できるのは、DEMレイキャストで遮蔽が無いと確かめた対象か、--vis の手動確証だけ。
  DEM未投入なら OSM由来の対象はすべて v:0(破線=透視)のまま。アプリの正直さゲートと同じ思想。
  DEMが欠けている区間を含む視線は「不明」であって「見える」ではない — v は 0 のままにする。

── DEM(標高タイル)の投入 ── オフライン2段構え。Overpassと同じ型。

  # ① 必要なタイルのDLスクリプトを出力(既定 z12 = 約27m/px。遠景の遮蔽判定には十分)
  python3 gpx2route.py input.gpx --emit-dem-fetch > fetch_dem.sh

  # ② 手元で実行(curlが地理院タイルを dem/ 以下に保存する)
  sh fetch_dem.sh

  # ③ --dem-tiles で投入。山座レジストリの v: が自動で付き、標高欠損も埋まる
  python3 gpx2route.py input.gpx --id takao --name "..." --osm poi.json --dem-tiles dem/
"""
import argparse, json, math, os, re, sys, zlib, xml.etree.ElementTree as ET

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

# ---------- v3.2: 地理院 標高タイル(DEM) ----------
DEM_HOST = 'https://cyberjapandata.gsi.go.jp/xyz'
EYE_H = 1.5          # 目の高さ m
K_REFR = 7.0 / 6.0   # 大気差込みの等価地球半径係数(標準屈折 k≈0.13)

def lon2tx(lo, z): return (lo + 180.0) / 360.0 * (2 ** z)
def lat2ty(la, z):
    r = math.radians(la)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (2 ** z)

def read_png_rgb(path):
    """stdlibだけでPNGを読む(8bit truecolor / +alpha・非インターレースのみ)。→ (w, h, RGBバイト列)
       Pillow等に依存しないのは、このツールを素のpython3だけで動かすため。"""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError(f'PNGではない: {path}')
    pos, idat, w, h, ctype = 8, [], None, None, None
    while pos + 8 <= len(data):
        ln = int.from_bytes(data[pos:pos + 4], 'big'); typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if typ == b'IHDR':
            w = int.from_bytes(body[0:4], 'big'); h = int.from_bytes(body[4:8], 'big')
            depth, ctype, interlace = body[8], body[9], body[12]
            if depth != 8 or ctype not in (2, 6) or interlace != 0:
                raise ValueError(f'未対応のPNG (depth={depth} colortype={ctype} interlace={interlace}): {path}')
        elif typ == b'IDAT': idat.append(body)
        elif typ == b'IEND': break
    if w is None or ctype is None: raise ValueError(f'IHDRがない: {path}')
    ch = 3 if ctype == 2 else 4
    buf, out, prev, p = zlib.decompress(b''.join(idat)), bytearray(w * h * 3), bytearray(w * ch), 0
    for y in range(h):
        f = buf[p]; p += 1
        line = bytearray(buf[p:p + w * ch]); p += w * ch
        if f == 1:
            for i in range(ch, len(line)): line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(len(line)): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(len(line)):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(len(line)):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]; c = prev[i - ch] if i >= ch else 0
                q = a + b - c
                pa, pb, pc = abs(q - a), abs(q - b), abs(q - c)
                line[i] = (line[i] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
        elif f != 0:
            raise ValueError(f'未対応のPNGフィルタ {f}: {path}')
        for x in range(w): out[(y * w + x) * 3:(y * w + x) * 3 + 3] = line[x * ch:x * ch + 3]
        prev = line
    return w, h, bytes(out)

def dem_elev_rgb(r, g, b):
    """地理院DEMのPNG画素→標高m。x=2^23 は無効(=(128,0,0))。0mと混同しないようNoneを返す。"""
    x = r * 65536 + g * 256 + b
    if x == 0x800000: return None
    return (x if x < 0x800000 else x - 0x1000000) * 0.01

class DemTiles:
    """--dem-tiles dir/ 配下の {z}/{x}/{y}.png から標高を引く(最も深いzを使う)"""
    def __init__(self, root):
        if not os.path.isdir(root): sys.exit(f'--dem-tiles: ディレクトリがない: {root}')
        zs = [int(d) for d in os.listdir(root) if d.isdigit() and os.path.isdir(os.path.join(root, d))]
        if not zs: sys.exit(f'--dem-tiles: {root} に {{z}}/{{x}}/{{y}}.png がない(--emit-dem-fetch で取得)')
        self.root, self.z, self.cache = root, max(zs), {}
        self.hit = self.miss = 0
        self.res_m = 156543.03 * math.cos(math.radians(35.0)) / (2 ** self.z)   # 概算 m/px

    def _tile(self, tx, ty):
        k = (tx, ty)
        if k not in self.cache:
            p = os.path.join(self.root, str(self.z), str(tx), f'{ty}.png')
            if not os.path.exists(p): self.cache[k] = None
            else:
                try:
                    w, h, rgb = read_png_rgb(p)
                    self.cache[k] = (w, h, [dem_elev_rgb(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
                                            for i in range(w * h)])
                except Exception as e:      # 壊れたタイルは「無い」扱い(嘘の標高を返さない)
                    sys.stderr.write(f'⚠ DEMタイルを読めない({e}) → 欠損扱い: {p}\n')
                    self.cache[k] = None
        return self.cache[k]

    def elev_max(self, la, lo):
        """周囲1セルの最大標高。低ズームDEMは尾根を平滑化して過小評価するので、
           遮蔽判定の地形側はこちらを使う(見える側に偏らせない)。"""
        dla = self.res_m / 110540.0
        dlo = self.res_m / (111320.0 * max(math.cos(math.radians(la)), 0.1))
        best = None
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                v = self.elev(la + i * dla, lo + j * dlo)
                if v is not None and (best is None or v > best): best = v
        return best

    def elev(self, la, lo):
        fx, fy = lon2tx(lo, self.z), lat2ty(la, self.z)
        tx, ty = int(math.floor(fx)), int(math.floor(fy))
        t = self._tile(tx, ty)
        if t is None: self.miss += 1; return None
        w, h, g = t
        ix = min(w - 1, max(0, int((fx - tx) * w)))
        iy = min(h - 1, max(0, int((fy - ty) * h)))
        v = g[iy * w + ix]
        if v is None: self.miss += 1
        else: self.hit += 1
        return v

def emit_dem_fetch(pts, radius_km, z, src):
    las = [p[0] for p in pts]; los = [p[1] for p in pts]
    k = math.cos(math.radians(sum(las) / len(las)))
    mla, mlo = radius_km * 1000 / 110540.0, radius_km * 1000 / (111320.0 * k)
    x0 = int(math.floor(lon2tx(min(los) - mlo, z))); x1 = int(math.floor(lon2tx(max(los) + mlo, z)))
    y0 = int(math.floor(lat2ty(max(las) + mla, z))); y1 = int(math.floor(lat2ty(min(las) - mla, z)))
    n = (x1 - x0 + 1) * (y1 - y0 + 1)
    res = 156543.03 * k / (2 ** z)
    print('#!/bin/sh')
    print(f'# 地理院 標高タイル {src} z{z} (約{res:.0f}m/px) を {n} 枚 dem/ に取得する')
    print(f'# 範囲: ルートbbox + {radius_km}km (山座の遮蔽判定に視線経路の地形が要る)')
    print('# 出典表示が必要: 「地図: 地理院タイル」')
    print('set -e')
    for x in range(x0, x1 + 1):
        print(f'mkdir -p dem/{z}/{x}')
        for y in range(y0, y1 + 1):
            print(f'curl -sfS -o dem/{z}/{x}/{y}.png {DEM_HOST}/{src}/{z}/{x}/{y}.png '
                  f'|| echo "  欠損: {z}/{x}/{y}" >&2')
    print(f'echo "完了: 最大 {n} 枚。--dem-tiles dem/ で投入する" >&2')

def _lerp_pt(a, b, f):
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)

def sight_blocked(obs, obs_el, tgt, tgt_el, dem, clearance=None, max_samples=400):
    """観測点→対象の視線が地形に遮られるか。
       戻り値 True=遮蔽 / False=見通せる / None=DEM欠損で判定不能(=見えるとは言わない)

       低ズームのDEMは尾根を平滑化して標高を過小評価する(z11実測: 高尾山599m→591m、
       富士山3776m→3761m)。過小評価は「見える」側に偏る=正直さゲートとして危険なので、
       地形側は周囲1セルの最大標高(elev_max)で見る。
       視線の余裕を一律に取る方式は不可: 観測点の足元では視線が必ず地面すれすれを通るため、
       近傍サンプルが常に遮蔽判定になり実際に見える対象まで落ちる(実測で確認済み)。
       代わりに両端 skip_m 以内のサンプルを除外する(自分が立っている地面には遮られない)。"""
    D = hav((obs[0], obs[1], 0), (tgt[0], tgt[1], 0))
    if D < 50: return False
    if clearance is None: clearance = 2.0
    skip_m = max(60.0, dem.res_m * 2)
    n = max(8, min(max_samples, int(D / max(dem.res_m, 1.0))))
    h0 = obs_el + EYE_H
    known = unknown = 0
    for i in range(1, n):
        f = i / n
        s = D * f
        if s < skip_m or (D - s) < skip_m: continue
        p = _lerp_pt(obs, tgt, f)
        h = dem.elev_max(p[0], p[1])
        if h is None: unknown += 1; continue
        known += 1
        drop = s * (D - s) / (2 * R * K_REFR)          # 地球の丸み+大気差
        los = h0 + (tgt_el - h0) * f - drop
        if h > los + clearance: return True
    if known == 0 or unknown > known * 0.25: return None
    return False

def apply_dem_visibility(pts, cum, reg, dem, max_obs=40):
    """ルート上の観測点から見える峰に v:1 を立てる。1点でも見通せれば可視。
       POIは建物遮蔽をDEMが持たないので自動判定しない(--vis の手動確証のみ)。"""
    idx = []
    if cum[-1] <= 0: idx = [0]
    else:
        for i in range(max_obs):
            want = cum[-1] * i / max(max_obs - 1, 1)
            j = min(range(len(cum)), key=lambda k: abs(cum[k] - want))
            if j not in idx: idx.append(j)
    obs = []
    for j in idx:
        el = dem.elev(pts[j][0], pts[j][1])
        obs.append(((pts[j][0], pts[j][1]), el if el is not None else pts[j][2]))
    seen = unknown = 0
    for r in reg:
        if r['t'] != 'peak' or r['v'] == 1: continue      # --vis の手動確証は上書きしない
        visible, any_known = False, False
        for (o, oel) in obs:
            b = sight_blocked(o, oel, (r['la'], r['lo']), r['el'], dem)
            if b is None: continue                        # DEM欠損 = 不明。見えるとは言わない
            any_known = True
            if b is False: visible = True; break
        if visible: r['v'] = 1; seen += 1
        elif not any_known: unknown += 1                  # 全観測点で判定不能 → v:0 のまま
    return seen, unknown

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
    ap.add_argument('--vis', default='', help='実線(可視確証)にする対象名のカンマ列。DEM判定の上書き手段')
    # v3.2 DEM
    ap.add_argument('--emit-dem-fetch', action='store_true', help='標高タイルのDLスクリプトを出力して終了(手元で実行→--dem-tilesで投入)')
    ap.add_argument('--dem-tiles', default=None, help='標高タイル置き場 {z}/{x}/{y}.png のルート。峰の可視判定と標高補完に使う')
    ap.add_argument('--dem-zoom', type=int, default=12, help='DEMのズーム (既定12 ≈ 27m/px。遠景の遮蔽判定はこれで十分)')
    ap.add_argument('--dem-src', default='dem_png', choices=['dem_png', 'dem5a_png'], help='タイル種別 (既定 dem_png。dem5a_pngはz15専用で欠損域あり)')
    ap.add_argument('--dem-radius-km', type=float, default=None, help='DL範囲: ルートbboxからの余裕km (既定は --peak-km と同じ)')
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
    if a.emit_dem_fetch:
        emit_dem_fetch(pts, a.dem_radius_km if a.dem_radius_km is not None else a.peak_km,
                       a.dem_zoom, a.dem_src)
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

    dem_note = ''
    if a.dem_tiles:
        dem = DemTiles(a.dem_tiles)
        filled = 0
        for r in reg:                                     # 標高欠損をDEMで埋める
            if not r['el']:
                e = dem.elev(r['la'], r['lo'])
                if e is not None: r['el'] = round(e); filled += 1
        seen, unknown = apply_dem_visibility(pts, cum, reg, dem)
        npk = sum(1 for r in reg if r['t'] == 'peak')
        dem_note = (f"DEM z{dem.z}(≈{dem.res_m:.0f}m/px): 峰{npk}件中 可視{seen}件を実線化"
                    f"{f' / 判定不能{unknown}件は破線のまま' if unknown else ''}"
                    f"{f' / 標高補完{filled}件' if filled else ''}\n")
        # GPXのele信頼性チェック(獲得標高と断面図の土台なので黙って通さない)
        # 簡略化後のptsは数点まで減りうるので、生のtrkから拾う
        dif = []
        for i in range(0, len(trk), max(1, len(trk) // 60)):
            e = dem.elev(trk[i][0], trk[i][1])
            if e is not None: dif.append(trk[i][2] - e)
        if len(dif) >= 5:
            bias = sum(dif) / len(dif)
            mad = sum(abs(d - bias) for d in dif) / len(dif)
            dem_note += f"GPX標高 vs DEM: 平均差 {bias:+.0f}m / ばらつき {mad:.0f}m (n={len(dif)})\n"
            if abs(bias) > 30 or mad > 30:
                dem_note += ("⚠ GPXの標高が疑わしい。獲得標高と断面図がずれる"
                             "(実測CTがあれば --ct で与える / 元GPXを確認)\n")
        if dem.miss > dem.hit:
            dem_note += "⚠ DEMの参照先が欠損だらけ(--emit-dem-fetch の範囲を広げたか確認)\n"
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
                     f"{f' / 上限超過{dropped}件を切り捨て' if dropped else ''}) / segs {len(segs)} / サイズ約 {len(obj)/1024:.1f}KB\n"
                     + dem_note)
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
