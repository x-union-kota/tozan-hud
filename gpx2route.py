#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gpx2route.py — GPX を 登山HUD の同梱ルート形式(JSオブジェクト)に変換する。

使い方:
  python3 gpx2route.py input.gpx --id yari --name "槍ヶ岳 上高地ルート" > route.js
  python3 gpx2route.py input.gpx --id x --name "..." --tol 6 --ct "0:0,3500:90,7200:210"

出力を index.html の ROUTES 配列に貼り付ける。

形式:
  poly : Google polyline (precision 1e-5, ~1m) で lat/lng を差分圧縮
  ele  : 同じ差分アルゴリズムの1次元版 (precision 1m)
  wps  : GPX の <wpt> をルート上の沿道距離(m)にスナップしたもの
         type は wpt の <type> か <cmt> から拾う (water/hut/junction/peak/escape/start/goal)
  cts  : [[沿道距離m, 標準CT累積分], ...]  --ct で与えるか、無指定なら
         標準式(登り300m/h+水平4km/h, 下り500m/h+水平4.5km/h)で自動生成
"""
import argparse, math, re, sys, xml.etree.ElementTree as ET

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
            f = (nxt-cum[i-1])/dd if dd>0 else 1
            out.append([round(nxt), round(t - (1-f)*0, 1)])  # 近似で十分
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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('gpx'); ap.add_argument('--id', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--tol', type=float, default=6.0, help='簡略化許容誤差 m')
    ap.add_argument('--ct', default=None, help='"沿道距離m:累積CT分" のカンマ列。無指定は標準式で自動')
    a = ap.parse_args()

    trk, wraw = load_gpx(a.gpx)
    if len(trk) < 2: sys.exit('trkpt がありません')
    pts = simplify(trk, a.tol)
    cum = cumdist(pts)
    total, gain = cum[-1], total_gain(pts)
    cts = parse_ct(a.ct, total) if a.ct else auto_ct(pts, cum)
    wps = [{'d': snap_wp(w, pts, cum), 'n': w[2] or f'WP{i+1}', 't': w[3] or 'wp'}
           for i,w in enumerate(wraw)]
    wps.sort(key=lambda w: w['d'])

    import json
    obj = (f"{{id:'{a.id}',name:'{a.name}',dist:{round(total)},gain:{round(gain)},"
           f"poly:'{enc_poly(pts)}',ele:'{enc_ele(pts)}',"
           f"wps:{json.dumps(wps, ensure_ascii=False, separators=(',',':'))},"
           f"cts:{json.dumps([[c[0],round(c[1])] for c in cts], separators=(',',':'))}}}")
    sys.stderr.write(f"点数 {len(trk)}→{len(pts)} / 距離 {total/1000:.1f}km / 獲得 {gain:.0f}m / "
                     f"サイズ約 {len(obj)/1024:.1f}KB\n")
    print(obj + ',')

if __name__ == '__main__':
    main()
