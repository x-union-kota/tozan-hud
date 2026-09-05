#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
osm_traces.py — OSM trackpoints API の応答(GPX 1.0、ページ分割)から「使える実歩行ログ」を選別する。

  python3 osm_traces.py osm-traces/  --start 35.6322,139.2699 --goal 35.6252,139.2436 \\
      --out picked/ [--min-pts 150] [--near 250] [--roundtrip]

やること:
  1. 全ページの <trk> を <url>(trace id)ごとに束ねる
  2. 時刻付きで単調増加しているトラックだけ残す(非公開設定のログは点がシャッフルされて届くので除外)
  3. 始点/終点が --start の近傍で、途中で --goal 近傍に達するものを抽出(--roundtrip なら往復のみ)
  4. 各ログの距離・所要時間・獲得標高・登り/下りの実測ペースを表と GPX(1.1・time付き)で出力
  5. 標準CT式(登り300m/h+水平4km/h, 下り500m/h+水平4.5km/h)との倍率を出す → 引き返し限界時刻の較正材料

出力GPXは gpx2route.py にそのまま食わせられる(<ele> が無いログは ele 0。標高は DEM で補完する前提)。
"""
import argparse, glob, math, os, re, sys, xml.etree.ElementTree as ET
from datetime import datetime, timezone

R = 6371000.0
def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

def strip(t): return re.sub(r'\{.*\}', '', t)

def parse_time(s):
    try: return datetime.strptime(s.strip(), '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except Exception: return None

def load_pages(d):
    """{trace_url: {'name','desc','pts':[(la,lo,ele|None,time|None)]}}"""
    traces = {}
    files = sorted(glob.glob(os.path.join(d, '*.gpx')), key=lambda f: int(re.findall(r'(\d+)\.gpx$', f)[0]) if re.findall(r'(\d+)\.gpx$', f) else 0)
    for f in files:
        try: root = ET.parse(f).getroot()
        except ET.ParseError: continue
        for trk in root.iter():
            if strip(trk.tag) != 'trk': continue
            url = name = desc = ''
            pts = []
            for c in trk:
                tg = strip(c.tag)
                if tg == 'url': url = (c.text or '').strip()
                elif tg == 'name': name = (c.text or '').strip()
                elif tg == 'desc': desc = (c.text or '').strip()
                elif tg == 'trkseg':
                    for p in c:
                        if strip(p.tag) != 'trkpt': continue
                        ele = tm = None
                        for q in p:
                            if strip(q.tag) == 'ele':
                                try: ele = float(q.text)
                                except: pass
                            elif strip(q.tag) == 'time': tm = parse_time(q.text or '')
                        pts.append((float(p.get('lat')), float(p.get('lon')), ele, tm))
            key = url or f'{name}|{desc}|{os.path.basename(f)}'
            t = traces.setdefault(key, {'name': name, 'desc': desc, 'pts': []})
            t['pts'].extend(pts)
    return traces

def monotonic_timed(pts):
    """時刻付きかつ単調増加(同時刻許容)。シャッフル済みログはここで落ちる"""
    ts = [p[3] for p in pts]
    if any(t is None for t in ts) or len(ts) < 2: return False
    bad = sum(1 for i in range(1, len(ts)) if ts[i] < ts[i-1])
    return bad <= max(2, len(ts)//200)   # ごく僅かな逆転(GPSの時刻補正)は許容

def dedupe_sort(pts):
    pts = sorted(pts, key=lambda p: p[3])
    out = [pts[0]]
    for p in pts[1:]:
        if p[3] != out[-1][3] or hav(p[:2], out[-1][:2]) > 1: out.append(p)
    return out

def stats(pts):
    dist = 0.0; up = 0.0; dn = 0.0
    for i in range(1, len(pts)):
        dist += hav(pts[i-1][:2], pts[i][:2])
        if pts[i][2] is not None and pts[i-1][2] is not None:
            de = pts[i][2] - pts[i-1][2]
            if abs(de) < 30:            # 標高スパイク除外
                if de > 0: up += de
                else: dn -= de
    dur = (pts[-1][3] - pts[0][3]).total_seconds()
    return dist, up, dn, dur

def std_ct_min(pts):
    """標準式CT(分)。ele が無い区間は水平分のみ"""
    t = 0.0
    for i in range(1, len(pts)):
        dd = hav(pts[i-1][:2], pts[i][:2])
        de = 0.0
        if pts[i][2] is not None and pts[i-1][2] is not None:
            de = pts[i][2] - pts[i-1][2]
            if abs(de) >= 30: de = 0.0
        if de >= 0: t += (dd/4000.0 + de/300.0)*60
        else:       t += (dd/4500.0 + (-de)/500.0)*60
    return t

def moving_time(pts, stop_speed=0.3):
    """停止(0.3m/s未満)を除いた行動時間(秒)"""
    mv = 0.0
    for i in range(1, len(pts)):
        dt = (pts[i][3]-pts[i-1][3]).total_seconds()
        if dt <= 0 or dt > 600: continue
        if hav(pts[i-1][:2], pts[i][:2])/dt >= stop_speed: mv += dt
    return mv

def resample(pts, step=50.0):
    """沿道 step(m) ごとに点を打ち直す(時刻・標高は線形補間)。DEM 標高をGPS点ごとに引くと
       位置ノイズ×地形勾配で獲得標高が水増しされるので、一定間隔に均してから引く"""
    if len(pts) < 2: return pts
    out = [pts[0]]; acc = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i-1], pts[i]
        d = hav(a[:2], b[:2])
        if d <= 0: continue
        while acc + d >= step:
            f = (step - acc) / d
            e = None if (a[2] is None or b[2] is None) else a[2] + (b[2]-a[2])*f
            t = a[3] + (b[3]-a[3])*f
            out.append((a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, e, t))
            a = out[-1]; d = hav(a[:2], b[:2]); acc = 0.0
            if d <= 0: break
        acc += d
    if hav(out[-1][:2], pts[-1][:2]) > 1: out.append(pts[-1])
    return out

def fill_dem(pts, dem, win=5):
    """<ele> が無い(trackpoints API は返さない)ログに DEM 標高を付ける。移動中央値で平滑化"""
    raw = [dem.elev(la, lo) for la, lo, _e, _t in pts]
    out = []
    for i in range(len(pts)):
        w = [v for v in raw[max(0, i-win//2):i+win//2+1] if v is not None]
        e = sorted(w)[len(w)//2] if w else None
        out.append((pts[i][0], pts[i][1], e, pts[i][3]))
    return out

def climb_segment(pts, s, g, near):
    """起点近傍を最後に離れてから山頂近傍に最初に着くまで(登り区間)の点列 / None"""
    gi = next((i for i, p in enumerate(pts) if hav(p[:2], g) <= near), None)
    if gi is None: return None
    si = next((i for i in range(gi, -1, -1) if hav(pts[i][:2], s) <= near), None)
    if si is None or gi - si < 20: return None
    return pts[si:gi+1]

def descent_segment(pts, s, g, near):
    """山頂近傍を最後に離れてから起点近傍に最後に着くまで(下り区間)。山頂での休憩は含まない"""
    gs = [i for i, p in enumerate(pts) if hav(p[:2], g) <= near]
    if not gs: return None
    gl = gs[-1]
    si = next((i for i in range(len(pts)-1, gl, -1) if hav(pts[i][:2], s) <= near), None)
    if si is None or si - gl < 20: return None
    return pts[gl:si+1]

def write_gpx(path, name, pts):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="osm_traces.py" xmlns="http://www.topografix.com/GPX/1/1">\n')
        f.write(f'<trk><name>{name}</name><trkseg>\n')
        for la, lo, ele, tm in pts:
            f.write(f'<trkpt lat="{la:.6f}" lon="{lo:.6f}">')
            if ele is not None: f.write(f'<ele>{ele:.1f}</ele>')
            f.write(f'<time>{tm.strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>\n')
        f.write('</trkseg></trk></gpx>\n')

def emit_fetch(bbox, out_dir):
    """OSM trackpoints API のページを空になるまで落とす bash を出力(実行はユーザーの手元で)"""
    print(f'''#!/bin/bash
# OSM 公開トレース(trackpoints API)を bbox={bbox} からページ分割で取得。1ページ最大5000点。
# 取得後: python3 tools/osm_traces.py {out_dir} --start LAT,LON --goal LAT,LON [--roundtrip] --out picked/
mkdir -p {out_dir}
for p in $(seq 0 400); do
  f={out_dir}/page-$p.gpx
  curl -sf "https://api.openstreetmap.org/api/0.6/trackpoints?bbox={bbox}&page=$p" -o "$f" || break
  grep -q '<trkpt' "$f" || {{ rm -f "$f"; break; }}
  echo "page $p: $(grep -c '<trkpt' "$f") 点"
  sleep 1
done
ls {out_dir} | wc -l''')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir', nargs='?', default=None)
    ap.add_argument('--emit-fetch', default=None, metavar='LEFT,BOTTOM,RIGHT,TOP',
                    help='トレースAPIのDLスクリプトを出力して終了(例 高尾: 139.235,35.615,139.280,35.640)')
    ap.add_argument('--start', default=None, help='lat,lon(起点。往復なら終点も)')
    ap.add_argument('--goal', default=None, help='lat,lon(山頂など、途中で到達すべき点)')
    ap.add_argument('--near', type=float, default=250, help='近傍判定 m')
    ap.add_argument('--min-pts', type=int, default=150)
    ap.add_argument('--roundtrip', action='store_true', help='起点に戻るログのみ')
    ap.add_argument('--out', default='picked')
    ap.add_argument('--dem-tiles', default=None, help='地理院DEMタイル {z}/{x}/{y}.png のルート。<ele> の無いログ(trackpoints API)に標高を付ける')
    ap.add_argument('--anywhere', action='store_true', help='始点/終点を問わず、--start 近傍を通ってから --goal に達したログを採り、その登り区間で倍率を出す')
    a = ap.parse_args()
    if a.emit_fetch:
        emit_fetch(a.emit_fetch, a.dir or 'osm-traces'); return
    if not (a.dir and a.start and a.goal): ap.error('dir / --start / --goal は必須(--emit-fetch 時を除く)')
    s = tuple(map(float, a.start.split(','))); g = tuple(map(float, a.goal.split(',')))

    dem = None
    if a.dem_tiles:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from gpx2route import DemTiles
        dem = DemTiles(a.dem_tiles)
    traces = load_pages(a.dir)
    n_all = len(traces); n_timed = 0; picked = []; climbs = []; descents = []
    for key, t in traces.items():
        pts = t['pts']
        if len(pts) < a.min_pts or not monotonic_timed(pts): continue
        n_timed += 1
        pts = dedupe_sort(pts)
        d0 = hav(pts[0][:2], s); d1 = hav(pts[-1][:2], s)
        reach = min(hav(p[:2], g) for p in pts)
        if reach > a.near: continue
        if a.anywhere:
            if min(hav(p[:2], s) for p in pts) > a.near: continue
        else:
            if d0 > a.near: continue
            if a.roundtrip and d1 > a.near: continue
        dist, up, dn, dur = stats(pts)
        if dur < 20*60 or dur > 12*3600: continue        # 20分未満/12時間超は除外
        if dem is not None and sum(1 for p in pts if p[2] is not None) < len(pts)*0.8:
            pts = fill_dem(resample(pts, 50.0), dem)
            dist, up, dn, dur = stats(pts)
        mv = moving_time(pts)
        ct = std_ct_min(pts)
        has_ele = sum(1 for p in pts if p[2] is not None) > len(pts)*0.8
        picked.append((key, t, pts, dist, up, dn, dur, mv, ct, has_ele, d1 <= a.near))
        seg = climb_segment(pts, s, g, a.near)
        if seg and has_ele:
            sd, su, sdn, sdur = stats(seg); sct = std_ct_min(seg)
            if sct > 0 and sdur >= 10*60: climbs.append((key, sd, su, sdur, sct, pts[0][3]))
        seg = descent_segment(pts, s, g, a.near)
        if seg and has_ele:
            sd, su, sdn, sdur = stats(seg); sct = std_ct_min(seg)
            if sct > 0 and sdur >= 10*60: descents.append((key, sd, sdn, sdur, sct, pts[0][3]))

    os.makedirs(a.out, exist_ok=True)
    print(f'traces {n_all} / 時刻付き単調 {n_timed} / 条件一致 {len(picked)}')
    # CT倍率は2種: 行動(停止除く)/CT と 所要(休憩込み)/CT。引き返し限界時刻は休憩込みで決まるので所要の方が較正材料
    print('#  日付        距離   獲得   所要   行動   倍率(行動/所要)  ele 往復  name')
    for i, (key, t, pts, dist, up, dn, dur, mv, ct, has_ele, rt) in enumerate(sorted(picked, key=lambda x: x[2][0][3])):
        ratio = (mv/60)/ct if (ct > 0 and has_ele) else float('nan')
        ratio_e = (dur/60)/ct if (ct > 0 and has_ele) else float('nan')
        fn = os.path.join(a.out, f'trace_{i:02d}.gpx')
        write_gpx(fn, t['name'] or key.split('/')[-1], pts)
        print(f'{i:02d} {pts[0][3].strftime("%Y-%m-%d")} {dist/1000:5.1f}km {up:5.0f}m {dur/3600:4.1f}h {mv/3600:4.1f}h  '
              f'{ratio:5.2f} / {ratio_e:5.2f}   {"有" if has_ele else "無"}  {"○" if rt else "×"}   {(t["name"] or key)[:40]}')
    if climbs:
        print('\n登り区間(起点近傍→山頂近傍)の実測 — 休憩込みの所要/標準CT:')
        print('#  日付        距離   獲得   所要   CT    倍率')
        rc = []
        for i, (key, sd, su, sdur, sct, t0) in enumerate(sorted(climbs, key=lambda x: x[5])):
            rc.append(sdur/60/sct)
            print(f'{i:02d} {t0.strftime("%Y-%m-%d")} {sd/1000:5.1f}km {su:5.0f}m {sdur/60:4.0f}分 {sct:4.0f}分 {sdur/60/sct:5.2f}')
        rc.sort()
        print(f'  登りの倍率: 中央値 {rc[len(rc)//2]:.2f} (n={len(rc)}, 範囲 {rc[0]:.2f}〜{rc[-1]:.2f})')
    if descents:
        # 引き返し限界時刻(C-1)は「復路CT + マージン」なので、較正に効くのはこちら
        print('\n下り区間(山頂近傍を最後に離れてから起点近傍まで。山頂休憩は含まず、途中休憩は含む):')
        print('#  日付        距離   下降   所要   CT    倍率')
        rd = []
        for i, (key, sd, sdn, sdur, sct, t0) in enumerate(sorted(descents, key=lambda x: x[5])):
            rd.append(sdur/60/sct)
            print(f'{i:02d} {t0.strftime("%Y-%m-%d")} {sd/1000:5.1f}km {sdn:5.0f}m {sdur/60:4.0f}分 {sct:4.0f}分 {sdur/60/sct:5.2f}')
        rd.sort()
        print(f'  下りの倍率: 中央値 {rd[len(rd)//2]:.2f} (n={len(rd)}, 範囲 {rd[0]:.2f}〜{rd[-1]:.2f}) → 復路CTに対する実所要。1.0超が出るならマージンはその分が要る')
    if picked:
        rs = [(x[7]/60)/x[8] for x in picked if x[9] and x[8] > 0]
        re_ = [(x[6]/60)/x[8] for x in picked if x[9] and x[8] > 0]
        if rs:
            rs.sort(); re_.sort(); med = rs[len(rs)//2]; med_e = re_[len(re_)//2]
            print(f'\n標準CTに対する行動時間の倍率: 中央値 {med:.2f} (n={len(rs)}, 範囲 {rs[0]:.2f}〜{rs[-1]:.2f})')
            print(f'標準CTに対する所要時間(休憩込み)の倍率: 中央値 {med_e:.2f} (範囲 {re_[0]:.2f}〜{re_[-1]:.2f})')
            print('  <1.0 = 標準式より速い人が多い(式が保守的) / >1.0 = 式が楽観的 → 引き返し限界のマージン設計に使う')
    else:
        print('条件に合うログなし。--near を広げる/--roundtrip を外す/--min-pts を下げる を試す')

if __name__ == '__main__':
    main()
