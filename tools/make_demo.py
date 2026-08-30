#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""3本のデモルート(架空)を生成して routes.js を吐く。実在の登山道ではない。"""
import json, math, random, sys
sys.path.insert(0, '.')
from gpx2route import simplify, cumdist, total_gain, enc_poly, enc_ele, auto_ct

random.seed(7)
LAT0, LON0 = 36.7480, 137.9520   # 架空の山域の基準点
MK = 1.0/110540.0                 # m→deg(lat)
def mlon(lat): return 1.0/(111320.0*math.cos(math.radians(lat)))

def catmull(ps, seg=20.0):
    """制御点(x,y m)をCatmull-Romで滑らかに補間、約segごとに点を打つ"""
    P = [ps[0]] + ps + [ps[-1]]
    out = []
    for i in range(1, len(P)-2):
        p0,p1,p2,p3 = P[i-1],P[i],P[i+1],P[i+2]
        L = math.hypot(p2[0]-p1[0], p2[1]-p1[1])
        n = max(2, int(L/seg))
        for j in range(n):
            t = j/n
            t2,t3 = t*t, t*t*t
            x = 0.5*((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3)
            y = 0.5*((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
            out.append((x,y))
    out.append(tuple(ps[-1]))
    return out

def jitter(xy, amp=9.0):
    """登山道らしい蛇行(進行方向と直交にオフセット)"""
    out = []
    ph1, ph2, ph3 = (random.random()*9 for _ in range(3))
    for i,(x,y) in enumerate(xy):
        a, b = xy[max(i-1,0)], xy[min(i+1,len(xy)-1)]
        dx, dy = b[0]-a[0], b[1]-a[1]
        L = math.hypot(dx,dy) or 1
        nx, ny = -dy/L, dx/L
        off = (amp*math.sin(i/6.0+ph1) + amp*0.45*math.sin(i/2.3+ph2)
               + amp*0.25*math.sin(i/1.1+ph3))
        out.append((x+nx*off, y+ny*off))
    return out

def to_ll(xy, lat0=LAT0, lon0=LON0):
    klon = mlon(lat0)
    return [(lat0 + y*MK, lon0 + x*klon) for x,y in xy]

def profile(n, segs):
    """segs=[(区間割合, 開始標高, 終了標高, 起伏amp)] から標高列を作る"""
    ele, acc = [], 0.0
    bounds = []
    for frac,a,b,amp in segs:
        bounds.append((acc, acc+frac, a, b, amp)); acc += frac
    for i in range(n):
        t = i/(n-1)
        for s0,s1,a,b,amp in bounds:
            if s0 <= t <= s1 or s1 == bounds[-1][1] and t >= s1:
                u = (t-s0)/max(s1-s0,1e-9); u = min(max(u,0),1)
                base = a + (b-a)*(0.5-0.5*math.cos(math.pi*u))  # 緩急つき
                ele.append(base + amp*math.sin(t*40+1.3) + amp*0.4*math.sin(t*97))
                break
    return ele

def build(name_id, name, ctrl, elesegs, closed=False, wps=None):
    xy = jitter(catmull(ctrl))
    if closed: xy.append(xy[0])
    ll = to_ll(xy)
    el = profile(len(ll), elesegs)
    pts = [(la,lo,e) for (la,lo),e in zip(ll,el)]
    pts = simplify(pts, 1.6)
    cum = cumdist(pts)
    total, gain = cum[-1], total_gain(pts)
    cts = auto_ct(pts, cum)
    # wps: [(沿道割合, 名前, type)]
    W = [{'d': round(total*f), 'n': n, 't': t} for f,n,t in (wps or [])]
    obj = {'id': name_id, 'name': name, 'dist': round(total), 'gain': round(gain),
           'poly': enc_poly(pts), 'ele': enc_ele(pts), 'wps': W,
           'cts': [[c[0], round(c[1])] for c in cts], 'demo': True}
    sys.stderr.write(f"{name}: {total/1000:.1f}km +{gain:.0f}m 点{len(pts)} CT{cts[-1][1]:.0f}分\n")
    return obj

# --- デモA 里山周回 (約5km, 自己接近区間あり: 序盤と終盤が谷を挟んで近接) ---
A = build('demoA', 'デモA 里山周回',
    [(0,0),(250,150),(500,420),(820,700),(1050,1100),(800,1500),(400,1700),
     (-50,1500),(-250,1100),(-180,700),(-60,350),(-30,120)],
    [(0.5, 420, 830, 6), (0.5, 830, 420, 6)], closed=True,
    wps=[(0,'登山口','start'),(0.28,'水場','water'),(0.5,'山頂','peak'),
         (0.74,'東屋','hut'),(1.0,'登山口','goal')])

# --- デモB 尾根ピストン (片道約4.3km 往復。往路=復路で単調射影のテスト用) ---
half = [(0,0),(300,260),(520,640),(600,1100),(820,1560),(1150,1900),
        (1300,2350),(1210,2820),(1420,3260),(1600,3660)]
Bxy = jitter(catmull(half))
Bxy = Bxy + Bxy[::-1]
Bll = to_ll(Bxy, LAT0+0.045, LON0+0.06)
Bel = profile(len(Bll), [(0.5, 610, 1390, 5), (0.5, 1390, 610, 5)])
Bpts = simplify([(la,lo,e) for (la,lo),e in zip(Bll,Bel)], 1.6)
Bcum = cumdist(Bpts); Btot, Bgain = Bcum[-1], total_gain(Bpts)
B = {'id':'demoB','name':'デモB 尾根ピストン','dist':round(Btot),'gain':round(Bgain),
     'poly':enc_poly(Bpts),'ele':enc_ele(Bpts),
     'wps':[{'d':0,'n':'登山口','t':'start'},{'d':round(Btot*0.30),'n':'鎖場下','t':'wp'},
            {'d':round(Btot*0.5),'n':'山頂','t':'peak'},{'d':round(Btot*0.70),'n':'鎖場下','t':'wp'},
            {'d':round(Btot),'n':'登山口','t':'goal'}],
     'cts':[[c[0],round(c[1])] for c in auto_ct(Bpts, Bcum)],'demo':True}
sys.stderr.write(f"デモB: {Btot/1000:.1f}km +{Bgain:.0f}m 点{len(Bpts)}\n")

# --- デモC 縦走 (約11km, 途中に撤退分岐) ---
C = build('demoC', 'デモC 三峰縦走',
    [(0,0),(400,300),(700,750),(650,1300),(950,1800),(1400,2100),(1900,2450),
     (2300,2950),(2500,3500),(2900,3900),(3400,4150),(3900,4500),(4200,5000),
     (4600,5500),(5100,5800),(5600,6200),(6100,6500),(6700,6800)],
    [(0.24, 540, 1160, 4), (0.14, 1160, 1000, 4), (0.18, 1000, 1290, 4),
     (0.12, 1290, 1180, 4), (0.14, 1180, 1330, 4), (0.18, 1330, 620, 5)],
    wps=[(0,'西登山口','start'),(0.22,'一ノ峰','peak'),(0.36,'鞍部の小屋 [撤退路]','escape'),
         (0.52,'二ノ峰','peak'),(0.66,'水場','water'),(0.82,'三ノ峰','peak'),(1.0,'東登山口','goal')])

routes = [A, B, C]
with open('../src/routes.js', 'w', encoding='utf-8') as f:
    f.write('// 自動生成: tools/make_demo.py  ※デモルートは架空。実際の山行には gpx2route.py で自作ルートを同梱すること\n')
    f.write('var ROUTES = ' + json.dumps(routes, ensure_ascii=False, separators=(',', ':')) + ';\n')
size = len(open('../src/routes.js', encoding='utf-8').read())
sys.stderr.write(f"routes.js 合計 {size/1024:.1f}KB\n")
