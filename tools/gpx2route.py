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

# ---------- v3.2: OSM道路ベクタ(ルート吸着 + 焼き込み) ----------
# 表示優先度。4=主要幹線 … 1=歩道/細街路。加算ディスプレイでは線種と太さで区別する
ROAD_CLASS = {
    'motorway': 4, 'trunk': 4, 'primary': 4,
    'motorway_link': 4, 'trunk_link': 4, 'primary_link': 4,
    'secondary': 3, 'tertiary': 3, 'secondary_link': 3, 'tertiary_link': 3,
    'residential': 2, 'unclassified': 2, 'living_street': 2, 'pedestrian': 2,
    'service': 1, 'footway': 1, 'sidewalk': 1, 'path': 1, 'steps': 1, 'cycleway': 1, 'track': 1,
}
SNAP_EXCLUDE = ('motorway', 'motorway_link')       # 首都高等の車専用道へ吸着させない
SNAP_TRAIL = ('path', 'footway', 'track', 'steps', 'pedestrian')   # mountainの主候補

def load_osm_ways(paths):
    """Overpass の `out geom` 応答から折れ線を取り出す → [(kind, cls, [(la,lo),...])]"""
    out = []
    for p in paths:
        try: doc = json.load(open(p, encoding='utf-8'))
        except Exception as e: sys.exit(f'OSM JSONを読めない: {p} ({e})')
        for el in doc.get('elements', doc if isinstance(doc, list) else []):
            geom = el.get('geometry')
            if not geom or len(geom) < 2: continue
            tags = el.get('tags') or {}
            line = [(g['lat'], g['lon']) for g in geom if 'lat' in g and 'lon' in g]
            if len(line) < 2: continue
            hw, rw = tags.get('highway'), tags.get('railway')
            if hw == 'footway' and tags.get('footway') == 'sidewalk': hw = 'sidewalk'   # 車道沿いの歩道
            if hw in ROAD_CLASS: out.append(('road', ROAD_CLASS[hw], line, hw))
            elif rw in ('rail', 'subway', 'light_rail', 'monorail', 'tram'):
                out.append(('rail', 1 if rw == 'subway' else 2, line, rw))
            elif tags.get('natural') == 'water' or tags.get('waterway') in ('riverbank', 'river', 'canal', 'moat'):
                out.append(('water', 1, line, tags.get('waterway') or 'water'))
    return out

def _pseg_pt(p, a, b):
    """点pから線分abへの (距離, 射影点)。すべてローカル平面座標(m)"""
    vx, vy = b[0] - a[0], b[1] - a[1]
    L2 = vx * vx + vy * vy
    if L2 <= 0: return math.hypot(p[0] - a[0], p[1] - a[1]), a
    t = max(0.0, min(1.0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2))
    q = (a[0] + vx * t, a[1] + vy * t)
    return math.hypot(p[0] - q[0], p[1] - q[1]), q

class SegIndex:
    """線分の格子インデックス。全探索だと 5000way×点数 で現実的な時間に終わらない。
       segs: [(a, b, way_id, s0)] — s0 はその道の始点からの弧長(m)"""
    def __init__(self, segs, cell=120.0):
        self.segs, self.cell, self.g = segs, cell, {}
        for i, (a, b, _w, _s) in enumerate(segs):
            n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / cell) + 1)
            for k in range(n + 1):
                t = k / n
                key = (int((a[0] + (b[0] - a[0]) * t) // cell), int((a[1] + (b[1] - a[1]) * t) // cell))
                self.g.setdefault(key, []).append(i)

    def candidates(self, p, r, k=8, dirv=None, cos_min=0.4):
        """点pの射影候補を距離順にk個 → [(距離, 射影点, way_id, 弧長)]。
           dirv/cos_min で進行方向に直交する道を候補から外す(直角に跳ねるのを防ぐ)。"""
        cx, cy, rad = int(p[0] // self.cell), int(p[1] // self.cell), int(r // self.cell) + 1
        seen, out = set(), []
        for dx in range(-rad, rad + 1):
            for dy in range(-rad, rad + 1):
                for i in self.g.get((cx + dx, cy + dy), ()):
                    if i in seen: continue
                    seen.add(i)
                    a, b, w, s0 = self.segs[i]
                    if dirv is not None:
                        sx, sy = b[0] - a[0], b[1] - a[1]
                        L = math.hypot(sx, sy)
                        if L <= 0 or abs((sx * dirv[0] + sy * dirv[1]) / L) < cos_min: continue
                    d, q = _pseg_pt(p, a, b)
                    if d <= r: out.append((d, q, w, s0 + math.hypot(q[0] - a[0], q[1] - a[1])))
        out.sort(key=lambda t: t[0])
        pick, used = [], set()          # 同じ道からは1つだけ(候補枠を平行な同一道路で埋めない)
        for c in out:
            if c[2] in used: continue
            used.add(c[2]); pick.append(c)
            if len(pick) >= k: break
        return pick

def densify(pts, step=10.0):
    """ルートを step 間隔に密化(標高は線形補間)"""
    out = [pts[0]]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        d = hav(a, b)
        n = max(1, int(d / step))
        for k in range(1, n + 1):
            f = k / n
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f))
    return out

def _at_arclen(xy, cum, s):
    """道 xy(累積長 cum)の弧長 s の位置"""
    s = max(0.0, min(cum[-1], s))
    lo, hi = 0, len(cum) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cum[mid] <= s: lo = mid
        else: hi = mid
    seg = cum[hi] - cum[lo]
    f = 0.0 if seg <= 0 else (s - cum[lo]) / seg
    return (xy[lo][0] + (xy[hi][0] - xy[lo][0]) * f, xy[lo][1] + (xy[hi][1] - xy[lo][1]) * f)

def snap_to_osm(pts, ways, domain, max_snap=60.0, step=10.0, beam=8, w_move=1.0, w_switch=60.0):
    """概形ルート/荒れたGPXを、同じOSMデータの道路網へ射影して一致させる。

       実測から分かった、この処理に必要な3段:
       ① 点ごとの最近傍射影だけでは地図マッチングにならない。密な都市部では点ごとに
          別の道を選んでしまい、ずれも距離も悪化する → 系列全体をViterbiで解く
          (放射コスト=射影距離、遷移コスト=|間隔-step|*w_move + 道が変わるなら w_switch)。
       ② 射影は横ずれしか消さない。縦方向のノイズが残るので距離が大きく水増しされる
          → 同じ道に乗っている区間は弧長を単調化して縦ジッタを消す。
       ③ 道から離れた区間は「吸着しない」を候補に持たせて原座標を維持する
          (堀・ブロック越えの誤吸着防止)。
       → (吸着後の点列, 統計dict)"""
    lat0 = pts[0][0]
    wxy, wcum, cand = {}, {}, []
    for wi, (kind, cls, line, sub) in enumerate(ways):
        if kind != 'road' or sub in SNAP_EXCLUDE: continue
        if domain == 'mountain' and sub not in SNAP_TRAIL and cls <= 1: continue
        xy = [_xy((q[0], q[1], 0), lat0) for q in line]
        cum = [0.0]
        for i in range(1, len(xy)):
            cum.append(cum[-1] + math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
        wxy[wi], wcum[wi] = xy, cum
        for i in range(1, len(xy)):
            cand.append((xy[i - 1], xy[i], wi, cum[i - 1]))
    if not cand: return pts, {'segs': 0, 'snapped': 0, 'total': 0, 'mean': 0.0, 'max': 0.0}
    idx = SegIndex(cand)
    dense = densify(pts, step)
    dxy = [_xy(p, lat0) for p in dense]

    NOSNAP = max_snap * 0.9            # 「吸着しない」候補の放射コスト
    cols = []
    for i, q in enumerate(dxy):
        a, b = dxy[max(0, i - 1)], dxy[min(len(dxy) - 1, i + 1)]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        dirv = ((b[0] - a[0]) / L, (b[1] - a[1]) / L) if L > 0 else None
        cs = idx.candidates(q, max_snap, beam, dirv)
        cs.append((NOSNAP, q, None, 0.0))
        cols.append(cs)

    cost = [c[0] for c in cols[0]]
    back = [[-1] * len(cols[0])]
    for i in range(1, len(cols)):
        cur, bk = [], []
        for (d, q, w, s) in cols[i]:
            best, bj = None, -1
            for j, (pd, pq, pw, ps) in enumerate(cols[i - 1]):
                t = abs(math.hypot(q[0] - pq[0], q[1] - pq[1]) - step) * w_move
                if w != pw: t += w_switch
                v = cost[j] + t
                if best is None or v < best: best, bj = v, j
            cur.append(best + d); bk.append(bj)
        cost, back = cur, back + [bk]
    j = min(range(len(cost)), key=lambda k: cost[k])
    chosen = [0] * len(cols)
    for i in range(len(cols) - 1, -1, -1):
        chosen[i] = j; j = back[i][j]
    picked = [cols[i][chosen[i]] for i in range(len(cols))]

    # ② 同じ道に乗り続けている区間は弧長を単調化する(縦ジッタ=距離水増しの正体)
    i = 0
    while i < len(picked):
        w = picked[i][2]
        if w is None: i += 1; continue
        j = i
        while j + 1 < len(picked) and picked[j + 1][2] == w: j += 1
        if j > i:
            fwd = picked[j][3] >= picked[i][3]
            run_v = None
            for k in range(i, j + 1):
                d, q, _w, s_k = picked[k]
                v = s_k if run_v is None else (max(run_v, s_k) if fwd else min(run_v, s_k))
                pnt = _at_arclen(wxy[w], wcum[w], v)
                if math.hypot(pnt[0] - dxy[k][0], pnt[1] - dxy[k][1]) > max_snap:
                    v, pnt = s_k, q     # 単調化を諦める。ただし道の上には残す(原座標へは戻さない)
                run_v = v
                picked[k] = (d, pnt, w, v)
        i = j + 1

    kx = 111320.0 * math.cos(math.radians(lat0))
    out, moved, snapped = [], [], 0
    for i, p in enumerate(dense):
        d, q, w, s = picked[i]
        if w is None: out.append(p); continue
        mv = math.hypot(q[0] - dxy[i][0], q[1] - dxy[i][1])
        if mv > max_snap:            # 単調化で押し出された点。max_snap の約束は破らない
            out.append(p); continue
        snapped += 1; moved.append(mv)
        out.append((q[1] / 110540.0, q[0] / kx, p[2]))       # _xy の逆変換
    st = {'segs': len(cand), 'snapped': snapped, 'total': len(dense),
          'mean': (sum(moved) / len(moved)) if moved else 0.0,
          'max': max(moved) if moved else 0.0}
    return out, st

# ---------- v3.2: 道路グラフ上のルーティング(概形 → 実在の道だけで結ぶ) ----------
# 「概形を道路に吸着させる」のは筋が悪い(道の無い場所を通る概形は直せない)。
# 概形の点列を経由点とみなし、OSM道路グラフの最短経路でつなげば、結果は定義上100%道の上。
ROUTE_W = {   # 経路コスト = 長さ × 係数。「大通りを一周」を作る前提で、
    # 大通り沿いの歩道(footway=sidewalk)と歩行者道を最優先。公園の遊歩道(無印footway/path)や
    # service(駐車場・私道)は遠回りしてでも避ける(皇居で実測: これらに5.6km+1.7km吸われた)
    'sidewalk': 0.9, 'pedestrian': 1.0, 'cycleway': 1.0, 'living_street': 1.0,
    'residential': 1.0, 'unclassified': 1.05, 'tertiary': 1.05, 'tertiary_link': 1.05,
    'secondary': 1.1, 'secondary_link': 1.1, 'primary': 1.15, 'primary_link': 1.15,
    'trunk': 1.3, 'trunk_link': 1.3,
    'footway': 1.6, 'path': 1.8, 'track': 1.6, 'service': 1.8, 'steps': 3.0,
}

STREET_W = {   # 「大通りを一周」プリセット: 公園の遊歩道・私道は3倍のコスト(事実上使わない)
    'sidewalk': 0.9, 'pedestrian': 1.0, 'cycleway': 1.0, 'living_street': 1.0,
    'residential': 1.0, 'unclassified': 1.05, 'tertiary': 1.05, 'tertiary_link': 1.05,
    'secondary': 1.1, 'secondary_link': 1.1, 'primary': 1.15, 'primary_link': 1.15,
    'trunk': 1.3, 'trunk_link': 1.3,
    'footway': 3.0, 'path': 3.0, 'track': 3.0, 'service': 3.0, 'steps': 4.0,
}
VIA_STREETS = ('sidewalk', 'pedestrian', 'cycleway', 'living_street', 'residential', 'unclassified',
               'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link')

def build_road_graph(ways, domain='urban', guide=None, corridor=40.0, weights=None):
    """→ (nodes:[(la,lo)], adj:{i:[(j, cost, len)]}, lat0)。ノードは座標を1e-6度で丸めて同一視。
       guide(概形の点列)を渡すと、概形から corridor(m) より離れた辺のコストを距離に比例して
       上げる(80m離れ=×2、200m離れ=×5)。これが無いと最短経路が概形の意図を無視して
       公園の遊歩道や城内の小道へ回り込む(皇居で実測: 5.0km の概形が 8.6km になった)"""
    lat0 = None
    for (k, cls, line, sub) in ways:
        if k == 'road' and line: lat0 = line[0][0]; break
    if lat0 is None: return None
    gidx = None
    if guide and len(guide) >= 2:
        gxy = [_xy(q, lat0) for q in guide]
        gidx = SegIndex([(gxy[i - 1], gxy[i], 0, 0.0) for i in range(1, len(gxy))], cell=200.0)
    def far_factor(la, lo):
        if gidx is None: return 1.0
        c = gidx.candidates(_xy((la, lo, 0), lat0), 2000.0, 1, None, -1.0)
        d = c[0][0] if c else 2000.0
        return 1.0 + max(0.0, d - corridor) / corridor
    key2i, nodes, adj = {}, [], {}
    def nid(la, lo):
        k = (round(la, 6), round(lo, 6))
        if k not in key2i:
            key2i[k] = len(nodes); nodes.append((la, lo)); adj[key2i[k]] = []
        return key2i[k]
    for (k, cls, line, sub) in ways:
        if k != 'road' or sub in SNAP_EXCLUDE: continue
        if domain == 'mountain' and sub not in SNAP_TRAIL and cls <= 1: continue
        w = (weights or ROUTE_W).get(sub, 1.2)
        prev = None
        for (la, lo) in line:
            i = nid(la, lo)
            if prev is not None and prev != i:
                d = hav((nodes[prev][0], nodes[prev][1]), (la, lo))
                ff = far_factor((nodes[prev][0] + la) / 2, (nodes[prev][1] + lo) / 2)
                adj[prev].append((i, d * w * ff, d)); adj[i].append((prev, d * w * ff, d))
                EDGE_LIST.append((prev, i)); EDGE_COST.append(w * ff); EDGE_SUB.append(sub)
            prev = i
    edge_idx = SegIndex([(_xy((nodes[u][0], nodes[u][1], 0), lat0), _xy((nodes[v][0], nodes[v][1], 0), lat0), k, 0.0)
                         for k, (u, v) in enumerate(EDGE_LIST)])
    return nodes, adj, lat0, edge_idx

def nearest_node(nodes, la, lo, r):
    best, bi = r, None
    for i, (a, b) in enumerate(nodes):
        if abs(a - la) * 110540.0 > r or abs(b - lo) * 111320.0 * 0.8 > r: continue
        d = hav((a, b), (la, lo))
        if d < best: best, bi = d, i
    return bi, best

def attach_point(nodes, adj, lat0, edge_idx, la, lo, r):
    """点を最寄りの**辺**へ射影し、その射影点を新ノードとして辺を分割して繋ぐ → ノード番号 / None。
       最寄り「ノード」に寄せると、交差点や公園の小道のノードが拾われて脇道へ往復する
       スパイクが立つ(皇居で実測: 5.0km の概形が 8.6km に)。辺への射影ならそれが起きない"""
    return [x[0] for x in attach_points(nodes, adj, lat0, edge_idx, la, lo, r, 1)] or [None]

def attach_points(nodes, adj, lat0, edge_idx, la, lo, r, k, allowed=None):
    """最寄り k 本の辺それぞれへ射影点を新ノードとして挿す → [(ノード番号, 射影距離), ...]
       allowed を渡すと、その種別の辺だけを候補にする(経由点を公園の小道に落とさない)"""
    # allowed 指定時は近い順に多めに引いて種別で絞る(濠沿いは footway/steps が最寄りを埋め尽くし、
    # 数十本では大通りの歩道に届かない: 大手門で実測)
    cs = edge_idx.candidates(_xy((la, lo, 0), lat0), r, k * 60 if allowed else k, None, -1.0)
    out = []
    for (d, q, eid, _s) in cs:
        if allowed and EDGE_SUB[eid] not in allowed: continue
        if len(out) >= k: break
        u, v = EDGE_LIST[eid]
        pla, plo = q[1] / 110540.0, q[0] / (111320.0 * math.cos(math.radians(lat0)))
        n = len(nodes); nodes.append((pla, plo)); adj[n] = []
        du, dv = hav(nodes[u], (pla, plo)), hav((pla, plo), nodes[v])
        wpm = EDGE_COST[eid]
        adj[u].append((n, du * wpm, du)); adj[n].append((u, du * wpm, du))
        adj[v].append((n, dv * wpm, dv)); adj[n].append((v, dv * wpm, dv))
        # 車道の中心線に落とした経由点は、歩道を走る経路から見ると「車道へ渡って戻る」ひげになる。
        # 歩道系が近くにあるならそちらを選ばせるため、車道系の射影距離に歩道1本分(15m)を上乗せ
        out.append((n, d + (0.0 if (not allowed or EDGE_SUB[eid] in WALK_STREETS) else VIA_CARRIAGEWAY_BIAS)))
    return out

WALK_STREETS = ('sidewalk', 'pedestrian', 'cycleway', 'living_street')
VIA_CARRIAGEWAY_BIAS = 15.0

EDGE_LIST, EDGE_COST, EDGE_SUB = [], [], []

def dijkstra_multi(adj, src, dsts, limit=1e18):
    """src から各 dst への最短コスト経路の実距離 {dst: m}。全部見つかるか limit を超えたら打ち切り。
       返すのは重み付きコストではなく実距離(m)。遷移コスト |網−直線| をコストで測ると、歩道(×0.9)の
       経路が直線より短く見えて車道中心の候補が選ばれ、歩道から車道へ渡って戻る16mのひげが立つ(晴海で実測)"""
    import heapq
    want = set(dsts); dist = {src: 0.0}; metre = {src: 0.0}; pq = [(0.0, src)]; out = {}
    while pq and want:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18): continue
        if u in want: out[u] = metre[u]; want.discard(u)
        if d > limit: break
        for (v, c, l) in adj.get(u, ()):
            nd = d + c
            if nd < dist.get(v, 1e18):
                dist[v] = nd; metre[v] = metre[u] + l; heapq.heappush(pq, (nd, v))
    return out

def dijkstra(adj, src, dst):
    import heapq
    dist = {src: 0.0}; prev = {}; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst: break
        if d > dist.get(u, 1e18): continue
        for (v, c, _l) in adj.get(u, ()):
            nd = d + c
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if dst not in dist: return None
    path = [dst]
    while path[-1] != src: path.append(prev[path[-1]])
    return path[::-1]

def route_on_graph(pts, ways, domain='urban', via_step=250.0, snap_r=300.0, K=4, LAM=2.5, debug=None, streets=False, via_pts=None):
    """概形 pts を via_step ごとの経由点にし、各経由点を snap_r 以内の最寄りノードへ寄せ、
       隣接する経由点どうしを最短経路で結ぶ。→ (点列, 統計dict)
       via_pts を渡すと概形の等間隔サンプルではなく、その点列だけを経由点にする(数個の角だけ指定して
       残りは道路網の最短路に任せる「大通りを一周」用)"""
    del EDGE_LIST[:]; del EDGE_COST[:]; del EDGE_SUB[:]
    # via_pts(角だけ指定)のときは概形の回廊ペナルティを切る。角を結ぶ直線は大通りから数百m離れ、
    # 本来通るべき道が「回廊外」扱いで数倍のコストになってしまう(皇居で実測: 半蔵門→桜田門が網8965)
    g = build_road_graph(ways, domain, guide=(None if via_pts else pts), weights=(STREET_W if streets else None))
    if not g: return pts, {'via': 0, 'ok': 0, 'skipped': 0}
    nodes, adj, lat0, edge_idx = g
    cum = cumdist(pts)
    vias, t = [], 0.0
    while t <= cum[-1]:
        i = 1
        while i < len(cum) and cum[i] < t: i += 1
        if i >= len(cum): vias.append(pts[-1]); break
        f = (t - cum[i - 1]) / max(1e-9, cum[i] - cum[i - 1])
        vias.append((pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                     pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f, pts[i - 1][2]))
        t += via_step
    if hav(vias[-1], pts[-1]) > 1: vias.append(pts[-1])
    if via_pts: vias = [(v[0], v[1], v[2] if len(v) > 2 else 0.0) for v in via_pts]
    # 経由点ごとに最寄り K 本の辺への射影を候補にし、系列全体を DP で選ぶ(HMM型マップマッチング)。
    # 遷移コスト = |網上の距離 − 経由点間の直線距離|。候補を1つに決め打ちすると、隣り合う
    # 射影が別の道に落ちて往復のスパイクが立つ(皇居で実測: 概形5.0kmが8.8kmに)
    cands, kept = [], []                                   # kept: 候補が取れた経由点(落ちた点で添字がずれないよう別持ち)
    for v in vias:
        cs = attach_points(nodes, adj, lat0, edge_idx, v[0], v[1], snap_r, K, VIA_STREETS if streets else None)
        if cs: cands.append(cs); kept.append(v)
    if not cands: return pts, {'via': len(vias), 'ok': 0, 'skipped': 0}
    # 周回(始点=終点)は最初と最後の経由点を同じ辺に落とす。別々に選ぶと始点で数十mの
    # ひげ(別の歩道へ渡って戻る)が立つ(皇居・桜田門で実測)。始点候補ごとに DP を回して最良を採る
    closed = len(cands) > 2 and hav(kept[0], kept[-1]) < 1.0
    nds = [None]
    for i in range(1, len(cands)):
        straight = hav(kept[i], kept[i - 1])
        # 前の候補それぞれから、今の候補全部への網距離をまとめて引く
        nds.append([dijkstra_multi(adj, pn, [c[0] for c in cands[i]], limit=straight * 4 + 2000) for (pn, _d) in cands[i - 1]])
    def run_dp(start):
        cost = [[(d if (start is None or ci == start) else 1e15) for ci, (_n, d) in enumerate(cands[0])]]
        back = [[-1] * len(cands[0])]
        for i in range(1, len(cands)):
            straight = hav(kept[i], kept[i - 1]); nd = nds[i]
            cur, bk = [], []
            for ci, (n, d) in enumerate(cands[i]):
                best, bj = None, -1
                if start is not None and i == len(cands) - 1 and ci != start:
                    cur.append(1e15); bk.append(0); continue
                for j in range(len(cands[i - 1])):
                    if n not in nd[j]: continue
                    t = cost[i - 1][j] + d + LAM * abs(nd[j][n] - straight)
                    if best is None or t < best: best, bj = t, j
                if best is None: best, bj = 1e15, 0                 # 繋がらない候補は事実上禁止
                cur.append(best); bk.append(bj)
            cost.append(cur); back.append(bk)
        j = min(range(len(cost[-1])), key=lambda x: cost[-1][x])
        tot = cost[-1][j]
        chosen = [0] * len(cands)
        for i in range(len(cands) - 1, -1, -1):
            chosen[i] = j; j = back[i][j]
        return tot, chosen
    if closed:
        _t, chosen = min((run_dp(s) for s in range(len(cands[0]))), key=lambda r: r[0])
    else:
        _t, chosen = run_dp(None)
    seq = [cands[i][chosen[i]][0] for i in range(len(cands))]
    chain, ok, skipped = [], 0, 0
    for li, (a, b) in enumerate(zip(seq, seq[1:])):
        path = dijkstra(adj, a, b)
        if not path: skipped += 1; continue
        ok += 1
        if debug is not None:
            net = sum(hav(nodes[path[k - 1]], nodes[path[k]]) for k in range(1, len(path)))
            debug.append((li, net, hav(vias[min(li, len(vias) - 1)], vias[min(li + 1, len(vias) - 1)])))
        chain.extend(path if not chain else path[1:])
    # 経由点ノードが経路の本線から外れた辺に落ちると「a→経由点→a」の往復(ひげ)が残る。
    # 同じノードへ引き返す並びを潰す(交差点で歩道の枝に6m触って戻る例が晴海で出た)
    i = 1
    while i < len(chain) - 1:
        if chain[i - 1] == chain[i + 1]: del chain[i:i + 2]; i = max(1, i - 1)
        else: i += 1
    out = [(nodes[i][0], nodes[i][1], 0.0) for i in chain]
    if len(out) < 2: return pts, {'via': len(vias), 'ok': ok, 'skipped': skipped}
    # 標高は元ルートの最寄り点から(道路グラフには標高が無い)
    for i in range(len(out)):
        best, be = 1e18, 0.0
        for q in pts:
            d = hav(out[i], q)
            if d < best: best, be = d, q[2]
        out[i] = (out[i][0], out[i][1], be)
    return out, {'via': len(vias), 'ok': ok, 'skipped': skipped, 'nodes': len(nodes)}

def route_deviation(orig, new):
    """origの各点から new 折れ線への距離 → (平均, 最大)。吸着で何m動いたかの実測値"""
    lat0 = orig[0][0]
    xy = [_xy(p, lat0) for p in new]
    ds = [min(_pseg(_xy(p, lat0), xy[i - 1], xy[i]) for i in range(1, len(xy))) for p in orig]
    return (sum(ds) / len(ds), max(ds))

def bake_vec(pts, ways, margin, tol, budget_kb):
    """地図パネル用のベクタを焼き込む。ルート近傍だけ・道路クラスで間引き・DP簡略化。"""
    lat0 = pts[0][0]
    xy_pts = [_xy(p, lat0) for p in pts]
    groups = {'road': [], 'water': [], 'rail': []}
    for (kind, cls, line, sub) in ways:
        # ルート回廊から遠い線は落とす(端点と中点で足切り→残ったら全点で判定)
        probe = [line[0], line[len(line) // 2], line[-1]]
        if min(min_dist_to_route((q[0], q[1], 0), xy_pts, lat0) for q in probe) > margin * 2:
            continue
        dmin = min(min_dist_to_route((q[0], q[1], 0), xy_pts, lat0) for q in line)
        # クラスごとに採用距離を変える。都市部で歩道・細街路まで全部拾うと
        # 加算ディスプレイでは線が塊になって地図として読めなくなる(実機前提の間引き)
        keep = margin if cls >= 3 else (min(margin, 200.0) if cls == 2 else min(margin, 80.0))
        if kind != 'road': keep = margin
        if dmin > keep: continue
        simp = simplify([(q[0], q[1], 0) for q in line], tol)
        if len(simp) >= 2: groups[kind].append((cls, simp))
    # サイズ予算: 超えたら優先度の低いものから落とす
    def size_of(gs):
        return sum(len(enc_poly(s)) + 6 for g in gs.values() for (_, s) in g)
    order = ['road', 'rail', 'water']
    while size_of(groups) > budget_kb * 1024:
        worst = None
        for k in order:
            for i, (cls, s) in enumerate(groups[k]):
                if worst is None or cls < worst[0]: worst = (cls, k, i)
        if worst is None: break
        groups[worst[1]].pop(worst[2])
    vec = {}
    for k in order:
        if groups[k]:
            vec[k] = [[cls, enc_poly(s)] for (cls, s) in sorted(groups[k], key=lambda x: -x[0])]
    return vec

# ---------- v3.2: 磁気偏角(WMM: 世界磁気モデル) ----------
WMM_URL = 'https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip'
WMM_TESTS = 'https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025_TEST_VALUES.txt'
WGS84_A, WGS84_F = 6378.137, 1.0 / 298.257223563     # km
GEOMAG_A = 6371.2                                    # 地磁気の基準半径 km

def load_wmm(path):
    """WMM.COF(または WMM****COF.zip)を読む → {'epoch','N','g','h','dg','dh'}"""
    if path.lower().endswith('.zip'):
        import zipfile
        z = zipfile.ZipFile(path)
        names = [i.filename for i in z.infolist() if i.filename.upper().endswith('.COF')]
        if not names: sys.exit(f'--wmm: zip の中に .COF が無い: {path}')
        names.sort(key=len)                          # WMM.COF を優先
        text = z.read(names[0]).decode('utf-8', errors='replace')
    else:
        text = open(path, encoding='utf-8', errors='replace').read()
    epoch, N = None, 0
    g = {}; h = {}; dg = {}; dh = {}
    for ln in text.splitlines():
        tk = ln.split()
        if not tk: continue
        if epoch is None:
            try: epoch = float(tk[0])
            except ValueError: continue
            continue
        if len(tk) < 6 or tk[0].startswith('9999'): continue
        try:
            n, m = int(tk[0]), int(tk[1])
            g[(n, m)], h[(n, m)] = float(tk[2]), float(tk[3])
            dg[(n, m)], dh[(n, m)] = float(tk[4]), float(tk[5])
        except ValueError:
            continue
        N = max(N, n)
    if epoch is None or not g: sys.exit(f'--wmm: 係数を読めなかった: {path}')
    return {'epoch': epoch, 'N': N, 'g': g, 'h': h, 'dg': dg, 'dh': dh}

def decimal_year(y, mo, d):
    import datetime
    d0 = datetime.date(y, 1, 1)
    days = (datetime.date(y, mo, d) - d0).days
    ylen = 366 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 365
    return y + days / ylen

def wmm_field(coef, lat_deg, lon_deg, alt_km, year):
    """WGS84測地座標の (lat, lon, 高度km) と十進年 → (X, Y, Z) nT (測地系: 北, 東, 下)"""
    N = coef['N']
    dt = year - coef['epoch']
    phi, lam = math.radians(lat_deg), math.radians(lon_deg)
    # 測地 → 地心球座標
    e2 = WGS84_F * (2 - WGS84_F)
    Rc = WGS84_A / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    p = (Rc + alt_km) * math.cos(phi)
    z = (Rc * (1 - e2) + alt_km) * math.sin(phi)
    r = math.hypot(p, z)
    phip = math.asin(z / r)                          # 地心緯度
    ct, st = math.sin(phip), math.cos(phip)          # cosθ, sinθ (θ=余緯度)

    # Schmidt準正規化ルジャンドル陪関数 P と dP/dθ
    P = [[0.0] * (N + 2) for _ in range(N + 2)]
    dP = [[0.0] * (N + 2) for _ in range(N + 2)]
    P[0][0], dP[0][0] = 1.0, 0.0
    for n in range(1, N + 1):
        for m in range(0, n + 1):
            if n == m:
                k = math.sqrt((2 * n - 1) / (2 * n)) if n > 1 else 1.0
                P[n][n] = st * P[n - 1][n - 1] * k
                dP[n][n] = (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]) * k
            else:
                k1 = math.sqrt(float(n * n - m * m))
                k2 = math.sqrt(float((n - 1) * (n - 1) - m * m)) if n - 1 >= m else 0.0
                P[n][m] = ((2 * n - 1) * ct * P[n - 1][m] - k2 * P[n - 2][m]) / k1
                dP[n][m] = ((2 * n - 1) * (ct * dP[n - 1][m] - st * P[n - 1][m])
                            - k2 * dP[n - 2][m]) / k1

    Xp = Yp = Zp = 0.0
    ratio = GEOMAG_A / r
    for n in range(1, N + 1):
        rn = ratio ** (n + 2)
        for m in range(0, n + 1):
            gnm = coef['g'].get((n, m), 0.0) + dt * coef['dg'].get((n, m), 0.0)
            hnm = coef['h'].get((n, m), 0.0) + dt * coef['dh'].get((n, m), 0.0)
            cml, sml = math.cos(m * lam), math.sin(m * lam)
            Xp += rn * (gnm * cml + hnm * sml) * dP[n][m]
            Yp += rn * m * (gnm * sml - hnm * cml) * P[n][m]
            Zp -= rn * (n + 1) * (gnm * cml + hnm * sml) * P[n][m]
    if abs(st) > 1e-10: Yp /= st
    else: Yp = 0.0                                    # 極: 特異。日本では通らない
    # 地心 → 測地への回転
    dphi = phip - phi
    X = Xp * math.cos(dphi) - Zp * math.sin(dphi)
    Z = Xp * math.sin(dphi) + Zp * math.cos(dphi)
    return X, Yp, Z

def wmm_declination(coef, lat_deg, lon_deg, alt_km, year):
    """西偏を正で返す(このツール/アプリの --dec と同じ符号。地理院の表記と揃える)"""
    X, Y, Z = wmm_field(coef, lat_deg, lon_deg, alt_km, year)
    return -math.degrees(math.atan2(Y, X))

def wmm_selftest(coef, path):
    """NOAA公式のテスト値ファイルと突き合わせる。実装が正しいかの唯一の確かな検証。
       書式: date height(km) lat lon X Y Z H F I D GV ... (# はコメント)"""
    rows = []
    for ln in open(path, encoding='utf-8', errors='replace'):
        ln = ln.strip()
        if not ln or ln.startswith('#'): continue
        try: v = [float(x) for x in ln.split()]
        except ValueError: continue
        if len(v) >= 11: rows.append(v)
    if not rows: sys.exit(f'--wmm-test: テスト値を1行も読めなかった: {path}')
    wd = wx = 0.0
    for v in rows:
        X, Y, Z = wmm_field(coef, v[2], v[3], v[1], v[0])
        D = math.degrees(math.atan2(Y, X))
        wd = max(wd, abs(D - v[10]))
        wx = max(wx, abs(X - v[4]), abs(Y - v[5]), abs(Z - v[6]))
    print(f'WMM自己検証: {len(rows)}点 / 偏角の最大誤差 {wd:.4f}° / 成分の最大誤差 {wx:.2f} nT')
    ok = wd <= 0.01 and wx <= 1.0
    print('判定: ' + ('一致' if ok else '不一致 — 実装かCOFを確認する'))
    return 0 if ok else 1

def emit_wmm_fetch():
    print('# 世界磁気モデル(WMM)の係数を手元にDLする。パブリックドメイン')
    print(f'# 公式テスト値(実装検証用): {WMM_TESTS}')
    print('set -e')
    print(f'curl -sfSL -o WMM2025COF.zip {WMM_URL}')
    print(f'curl -sfSL -o WMM_TEST_VALUES.txt {WMM_TESTS}')
    print('echo "完了: gpx2route.py --wmm WMM2025COF.zip (zipのまま渡してよい)" >&2')
    print('echo "  実装検証: gpx2route.py --wmm WMM2025COF.zip --wmm-test WMM_TEST_VALUES.txt" >&2')

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
def emit_query(pts, poi_radius, peak_km, vec_margin=400.0):
    las = [p[0] for p in pts]; los = [p[1] for p in pts]
    mgn_poi = (poi_radius + 500) / 110540.0
    k = math.cos(math.radians(sum(las)/len(las)))
    mgn_poi_lo = (poi_radius + 500) / (111320.0 * k)
    mgn_pk = peak_km * 1000 / 110540.0
    mgn_pk_lo = peak_km * 1000 / (111320.0 * k)
    bb_poi = f"{min(las)-mgn_poi:.4f},{min(los)-mgn_poi_lo:.4f},{max(las)+mgn_poi:.4f},{max(los)+mgn_poi_lo:.4f}"
    bb_pk  = f"{min(las)-mgn_pk:.4f},{min(los)-mgn_pk_lo:.4f},{max(las)+mgn_pk:.4f},{max(los)+mgn_pk_lo:.4f}"
    mgn_v, mgn_v_lo = vec_margin / 110540.0, vec_margin / (111320.0 * k)
    bb_vec = f"{min(las)-mgn_v:.4f},{min(los)-mgn_v_lo:.4f},{max(las)+mgn_v:.4f},{max(los)+mgn_v_lo:.4f}"
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
// --- v3.2: 地図パネル用の道路/鉄道/水域ベクタ と ルート吸着の材料(ジオメトリが要る) ---
(
  way["highway"]({bb_vec});
  way["railway"~"^(rail|subway|light_rail|monorail|tram)$"]({bb_vec});
  way["natural"="water"]({bb_vec});
  way["waterway"~"^(riverbank|river|canal|moat)$"]({bb_vec});
);
out geom;
// 実行例: curl -sG https://overpass-api.de/api/interpreter --data-urlencode data@query.txt > poi.json
// bbox: POI近傍={bb_poi} / 山頂={bb_pk} ({peak_km}km圏) / ベクタ={bb_vec}
// shop/tower も欲しい場合は該当行を足す(都市部では件数が溢れるので既定では出さない)"""
    print(q)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('gpx', nargs='?', help='入力GPX (--emit-wmm-fetch / --wmm-test 時は不要)')
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
    # v3.2 OSM道路ベクタ
    ap.add_argument('--route-osm', action='store_true', help='概形を経由点にして道路グラフの最短経路で結び直す(結果は100%%道の上)')
    ap.add_argument('--via-step', type=float, default=250.0, help='--route-osm の経由点間隔 m (既定250)')
    ap.add_argument('--no-snap', action='store_true', help='--osm があってもルートの道路吸着をしない')
    ap.add_argument('--snap-max', type=float, default=60.0, help='吸着を諦める射影距離 m (既定60。堀・ブロック越えの誤吸着防止)')
    ap.add_argument('--no-vec', action='store_true', help='地図パネル用の道路ベクタを焼き込まない')
    ap.add_argument('--vec-margin', type=float, default=400.0, help='ベクタ採用: ルートからの距離 m (既定400)')
    ap.add_argument('--vec-kb', type=float, default=30.0, help='ベクタのサイズ予算 KB (既定30。超過分は優先度の低い線から落とす)')
    ap.add_argument('--seg', action='append', default=[], help='区間ボス "a-b:名前" (a,b: 0〜1=割合 / それ以外=m。複数可)')
    ap.add_argument('--dec', type=float, default=None, help='磁気偏角(西偏+)を手で与える。--wmm より優先。無指定で--wmmも無ければ7.5')
    # v3.2 WMM
    ap.add_argument('--emit-wmm-fetch', action='store_true', help='WMM係数のDLスクリプトを出力して終了')
    ap.add_argument('--wmm', default=None, help='WMM係数 (.COF か WMM****COF.zip)。ルート重心の偏角を自動算出')
    ap.add_argument('--date', default=None, help='偏角の基準日 YYYY-MM-DD (既定: 今日)')
    ap.add_argument('--wmm-test', default=None, help='NOAA公式テスト値ファイルと突き合わせて終了(実装検証)')
    ap.add_argument('--domain', default='auto', choices=['auto', 'mountain', 'urban'])
    ap.add_argument('--max-reg', type=int, default=80, help='regの上限件数 (既定80)')
    ap.add_argument('--dump-json', default=None, help='(検証用) 厳密JSONも書き出す')
    a = ap.parse_args()

    # GPXを要さないモードは先に処理する
    if a.emit_wmm_fetch:
        emit_wmm_fetch()
        return
    if a.wmm_test:
        if not a.wmm: sys.exit('--wmm-test には --wmm も要る')
        sys.exit(wmm_selftest(load_wmm(a.wmm), a.wmm_test))
    if not a.gpx: sys.exit('入力GPXを指定する')

    trk, wraw = load_gpx(a.gpx)
    if len(trk) < 2: sys.exit('trkpt がありません')
    pts = simplify(trk, a.tol)

    if a.emit_query:
        emit_query(pts, a.poi_radius, a.peak_km, a.vec_margin)
        return
    if a.emit_dem_fetch:
        emit_dem_fetch(pts, a.dem_radius_km if a.dem_radius_km is not None else a.peak_km,
                       a.dem_zoom, a.dem_src)
        return
    if not a.id or not a.name: sys.exit('--id と --name は必須です(--emit-query 時を除く)')

    # --- v3.2: ルートの道路吸着。ジオメトリが変わるので距離/CT/WPスナップより先に済ませる ---
    ways = load_osm_ways(a.osm) if a.osm else []
    snap_note = ''
    if ways and a.route_osm:
        pre_cum = cumdist(pts)
        dom0 = a.domain if a.domain != 'auto' else \
               ('urban' if total_gain(pts) / max(pre_cum[-1] / 1000, 0.1) < 15 else 'mountain')
        routed, st = route_on_graph(pts, ways, dom0, a.via_step, a.snap_max * 5)
        if st.get('ok'):
            before = pts
            pts = simplify(routed, a.tol)
            after = cumdist(pts)[-1]
            snap_note = (f"route-osm: 経由点{st['via']} → 最短経路{st['ok']}本"
                         f"{f'(結べず{st["skipped"]})' if st['skipped'] else ''} / ノード{st['nodes']} → {len(pts)}点\n"
                         f"  距離 {pre_cum[-1]:.0f}m → {after:.0f}m / 元ジオメトリとの差 平均{route_deviation(before, pts)[0]:.1f}m\n")
        else:
            snap_note = 'route-osm: 経由点を道路グラフに乗せられなかった(原ジオメトリを維持)\n'
    elif ways and not a.no_snap:
        pre_cum = cumdist(pts); pre_gain = total_gain(pts)
        dom0 = a.domain if a.domain != 'auto' else \
               ('urban' if pre_gain / max(pre_cum[-1] / 1000, 0.1) < 15 else 'mountain')
        snapped, st = snap_to_osm(pts, ways, dom0, a.snap_max)
        if st['snapped']:
            before = pts
            pts = simplify(snapped, a.tol)
            dev = route_deviation(before, pts)
            after = cumdist(pts)[-1]
            dpct = (after / pre_cum[-1] - 1) * 100 if pre_cum[-1] > 0 else 0.0
            snap_note = (f"snap-osm: 道路{st['segs']}セグメントへ {st['snapped']}/{st['total']}点を吸着"
                         f"(射影 平均{st['mean']:.1f}m / 最大{st['max']:.1f}m) → {len(pts)}点\n"
                         f"  元ジオメトリとの差: 平均{dev[0]:.1f}m / 最大{dev[1]:.1f}m"
                         f"{'  ← 逸脱閾値50mを超える差が元ルートにあった(判定精度の修正)' if dev[1] > 50 else ''}\n"
                         f"  距離 {pre_cum[-1]:.0f}m → {after:.0f}m ({dpct:+.0f}%)\n")
            if abs(dpct) > 10:
                snap_note += ("⚠ 吸着で距離が10%以上変わった。距離はCT・ペース・残距離の土台なので、"
                              "--dump-json で形を確認するか --no-snap を検討する\n")
        else:
            snap_note = f"snap-osm: 吸着できる道路が {a.snap_max:.0f}m 以内に無かった(原ジオメトリを維持)\n"

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

    # --- v3.2: 磁気偏角。--dec > --wmm > 既定7.5 の順で決める ---
    dec, dec_note = 7.5, ''
    if a.wmm:
        import datetime
        coef = load_wmm(a.wmm)
        if a.date:
            try: yy, mm, dd = [int(x) for x in a.date.split('-')]
            except ValueError: sys.exit(f'--date の書式エラー: {a.date} (YYYY-MM-DD)')
        else:
            td = datetime.date.today(); yy, mm, dd = td.year, td.month, td.day
        yr = decimal_year(yy, mm, dd)
        cla = sum(p[0] for p in pts) / len(pts)
        clo = sum(p[1] for p in pts) / len(pts)
        cel = sum(p[2] for p in pts) / len(pts) / 1000.0
        wdec = round(wmm_declination(coef, cla, clo, cel, yr), 2)
        ep = int(coef['epoch'])
        dec_note = (f'偏角: WMM{ep} 次数{coef["N"]} / 重心({cla:.3f},{clo:.3f}) {yy}-{mm:02d}-{dd:02d}'
                    f' → 西偏 {wdec:.2f}°\n')
        if not (coef['epoch'] <= yr <= coef['epoch'] + 5):
            dec_note += (f'⚠ WMM{ep} の有効期間({ep}〜{ep + 5})の外。新しい係数に更新すること'
                         f'(--emit-wmm-fetch)\n')
        dec = wdec
    if a.dec is not None:
        if a.wmm: dec_note += f'  --dec {a.dec} を明示指定 → WMMの算出値を上書き\n'
        dec = a.dec
    elif not a.wmm:
        dec_note = '偏角: 既定7.5°(--wmm で世界磁気モデルから自動算出できる)\n'

    vec, vec_note = {}, ''
    if ways and not a.no_vec:
        vec = bake_vec(pts, ways, a.vec_margin, a.tol, a.vec_kb)
        nline = sum(len(v) for v in vec.values())
        vkb = sum(len(p) for v in vec.values() for (_, p) in v) / 1024.0
        vec_note = (f"vec: {nline}本 焼き込み ({' / '.join(f'{k}{len(v)}' for k, v in vec.items())}) "
                    f"約{vkb:.1f}KB\n") if nline else ''

    vec_s = f"vec:{json.dumps(vec, separators=(',', ':'))}," if vec else ''
    obj = (f"{{id:'{a.id}',name:'{a.name}',dist:{round(total)},gain:{round(gain)},"
           f"poly:'{enc_poly(pts)}',ele:'{enc_ele(pts)}',{vec_s}"
           f"wps:{json.dumps(wps, ensure_ascii=False, separators=(',',':'))},"
           f"cts:{json.dumps([[c[0],round(c[1])] for c in cts], separators=(',',':'))},"
           f"reg:{json.dumps(reg, ensure_ascii=False, separators=(',',':'))},"
           f"segs:{json.dumps(segs, ensure_ascii=False, separators=(',',':'))},"
           f"dec:{dec},domain:'{domain}'}}")
    sys.stderr.write(f"点数 {len(trk)}→{len(pts)} / 距離 {total/1000:.1f}km / 獲得 {gain:.0f}m / domain {domain}\n"
                     f"reg {len(reg)}件 (峰{sum(1 for r in reg if r['t']=='peak')} POI{sum(1 for r in reg if r['t']!='peak')}"
                     f"{f' / 上限超過{dropped}件を切り捨て' if dropped else ''}) / segs {len(segs)} / サイズ約 {len(obj)/1024:.1f}KB\n"
                     + snap_note + vec_note + dem_note + dec_note)
    if missing_vis:
        sys.stderr.write(f"⚠ --vis 指定がregに見つからない: {', '.join(missing_vis)} (綴りを確認)\n")
    if a.osm and not osm_items and not ways:
        sys.stderr.write("⚠ OSM JSONから対象が1件も取れていない(クエリ/ファイルを確認)\n")
    if a.dump_json:
        full = {'id': a.id, 'name': a.name, 'dist': round(total), 'gain': round(gain),
                'wps': wps, 'reg': reg, 'segs': segs, 'dec': dec, 'domain': domain}
        json.dump(full, open(a.dump_json, 'w', encoding='utf-8'), ensure_ascii=False)
    print(obj + ',')

if __name__ == '__main__':
    main()
