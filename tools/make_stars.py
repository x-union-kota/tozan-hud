#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""星表生成 → src/stars.js

引数なし: 従来どおり手書きの精選版(輝星約70+主要星座線)を出力する。

外部星表の投入(オフライン2段構え。Overpass/DEMと同じ型):
  python3 make_stars.py --emit-fetch                       # DL先とライセンスを出力
  # 手元でDL(ブラウザ or curl)してから
  python3 make_stars.py --hyg hygdata_v3.csv --lines constellationship.fab

── 星座線が参照する星は等級カットの例外 ── これが本ツールの肝。
ラベル用は明るい星だけでよいが、fab の線分が HIP 参照する星は暗くても座標を
収録しないと線が欠ける。そこで2系統に分けて出力する:
  s: ラベル用 [名前, RA時, Dec度, 等級, 星座略号]  — 等級カット内。名前は無いこともある
  v: 線の頂点専用 [RA時, Dec度, 等級]              — 等級カット外。点は小さく、ラベルは出さない
  c: {略号: {n: 和名, l: [[i,j], ...]}}            — 添字は s.concat(v) の連結インデックス空間
連結空間にしておけば、描画側は連結配列を1本引くだけで済み、等級カットを変えても
v が自動で埋め合わせる。fab の参照HIPを解決できたかは終了時に必ず検査する。

ライセンス: 星表 HYG Database (CC BY-SA) / 星座線 Stellarium (GPL系)。
表示クレジットは README と診断画面に出す。
J2000。ラベル用途(±1°級)なので歳差は無視できる誤差ではないが視認一致には十分。"""
import argparse, csv, json, math, os, sys

# 2026-08 時点で到達確認済みのURL。HYGは .gz のまま渡してよい(gzipのまま読む)
HYG_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz'
HYG_ALT = 'https://astronexus.com/downloads/catalogs (hygdata_v3.csv 等の旧版でも列名が同じなら読める)'
# Stellariumの modern スカイカルチャは constellationship.fab を廃し index.json に移行済み。
# 旧 .fab を持っているならそれも読める(load_lines が両方を判別する)
LINES_URL = ('https://raw.githubusercontent.com/Stellarium/stellarium/master/'
             'skycultures/modern/index.json')

# 88星座の略号→和名。ラベル表示用の上書き辞書
CONST_JA = {
 'And':'アンドロメダ座','Ant':'ポンプ座','Aps':'ふうちょう座','Aqr':'みずがめ座','Aql':'わし座',
 'Ara':'さいだん座','Ari':'おひつじ座','Aur':'ぎょしゃ座','Boo':'うしかい座','Cae':'ちょうこくぐ座',
 'Cam':'きりん座','Cnc':'かに座','CVn':'りょうけん座','CMa':'おおいぬ座','CMi':'こいぬ座',
 'Cap':'やぎ座','Car':'りゅうこつ座','Cas':'カシオペヤ座','Cen':'ケンタウルス座','Cep':'ケフェウス座',
 'Cet':'くじら座','Cha':'カメレオン座','Cir':'コンパス座','Col':'はと座','Com':'かみのけ座',
 'CrA':'みなみのかんむり座','CrB':'かんむり座','Crv':'からす座','Crt':'コップ座','Cru':'みなみじゅうじ座',
 'Cyg':'はくちょう座','Del':'いるか座','Dor':'かじき座','Dra':'りゅう座','Equ':'こうま座',
 'Eri':'エリダヌス座','For':'ろ座','Gem':'ふたご座','Gru':'つる座','Her':'ヘルクレス座',
 'Hor':'とけい座','Hya':'うみへび座','Hyi':'みずへび座','Ind':'インディアン座','Lac':'とかげ座',
 'Leo':'しし座','LMi':'こじし座','Lep':'うさぎ座','Lib':'てんびん座','Lup':'おおかみ座',
 'Lyn':'やまねこ座','Lyr':'こと座','Men':'テーブルさん座','Mic':'けんびきょう座','Mon':'いっかくじゅう座',
 'Mus':'はえ座','Nor':'じょうぎ座','Oct':'はちぶんぎ座','Oph':'へびつかい座','Ori':'オリオン座',
 'Pav':'くじゃく座','Peg':'ペガスス座','Per':'ペルセウス座','Phe':'ほうおう座','Pic':'がか座',
 'Psc':'うお座','PsA':'みなみのうお座','Pup':'とも座','Pyx':'らしんばん座','Ret':'レチクル座',
 'Sge':'や座','Sgr':'いて座','Sco':'さそり座','Scl':'ちょうこくしつ座','Sct':'たて座',
 'Ser':'へび座','Sex':'ろくぶんぎ座','Tau':'おうし座','Tel':'ぼうえんきょう座','Tri':'さんかく座',
 'TrA':'みなみのさんかく座','Tuc':'きょしちょう座','UMa':'おおぐま座','UMi':'こぐま座','Vel':'ほ座',
 'Vir':'おとめ座','Vol':'とびうお座','Vul':'こぎつね座',
}



# (和名/通称, RA時, Dec度, mag, 星座キー)
STARS = [
 ('シリウス',6.752,-16.72,-1.46,'CMa'),('カノープス',6.399,-52.70,-0.74,''),
 ('アークトゥルス',14.261,19.18,-0.05,'Boo'),('ベガ',18.616,38.78,0.03,'Lyr'),
 ('カペラ',5.278,45.998,0.08,'Aur'),('リゲル',5.242,-8.20,0.13,'Ori'),
 ('プロキオン',7.655,5.22,0.34,'CMi'),('ベテルギウス',5.919,7.407,0.42,'Ori'),
 ('アルタイル',19.846,8.87,0.77,'Aql'),('アルデバラン',4.599,16.51,0.86,'Tau'),
 ('スピカ',13.420,-11.16,0.97,'Vir'),('アンタレス',16.490,-26.43,1.06,'Sco'),
 ('ポルックス',7.755,28.03,1.14,'Gem'),('フォーマルハウト',22.961,-29.62,1.16,'PsA'),
 ('デネブ',20.690,45.28,1.25,'Cyg'),('レグルス',10.139,11.97,1.36,'Leo'),
 ('カストル',7.577,31.89,1.58,'Gem'),('ベラトリクス',5.418,6.35,1.64,'Ori'),
 ('エルナト',5.438,28.61,1.65,'Tau'),('アルニラム',5.604,-1.20,1.69,'Ori'),
 ('アルニタク',5.679,-1.94,1.77,'Ori'),('アリオト',12.900,55.96,1.77,'UMa'),
 ('カフ',0.153,59.15,2.27,'Cas'),('シェダル',0.675,56.54,2.23,'Cas'),
 ('ツィー',0.945,60.72,2.47,'Cas'),('ルクバー',1.430,60.24,2.68,'Cas'),
 ('セギン',1.907,63.67,3.38,'Cas'),
 ('ドゥーベ',11.062,61.75,1.79,'UMa'),('メラク',11.031,56.38,2.37,'UMa'),
 ('フェクダ',11.897,53.69,2.44,'UMa'),('メグレズ',12.257,57.03,3.31,'UMa'),
 ('ミザール',13.399,54.93,2.27,'UMa'),('アルカイド',13.792,49.31,1.86,'UMa'),
 ('ポラリス(北極星)',2.530,89.26,1.98,'UMi'),
 ('ミンタカ',5.533,-0.30,2.23,'Ori'),('サイフ',5.796,-9.67,2.09,'Ori'),
 ('アルビレオ',19.512,27.96,3.18,'Cyg'),('サドル',20.371,40.26,2.20,'Cyg'),
 ('ギェナー',20.770,33.97,2.46,'Cyg'),('δCyg',19.749,45.13,2.87,'Cyg'),
 ('シャウラ',17.560,-37.10,1.63,'Sco'),('サルガス',17.622,-43.00,1.87,'Sco'),
 ('ζSco',16.910,-42.36,3.62,'Sco'),('δSco',16.005,-22.62,2.32,'Sco'),
 ('βSco',16.091,-19.81,2.62,'Sco'),
 ('デネボラ',11.818,14.57,2.13,'Leo'),('アルギエバ',10.333,19.84,2.28,'Leo'),
 ('ゾスマ',11.235,20.52,2.56,'Leo'),
 ('ハマル',2.120,23.46,2.00,'Ari'),('ミラク',1.162,35.62,2.06,'And'),
 ('アルフェラッツ',0.140,29.09,2.06,'And'),('アルマク',2.065,42.33,2.26,'And'),
 ('マルカブ',23.079,15.21,2.48,'Peg'),('シェアト',23.063,28.08,2.42,'Peg'),
 ('アルゲニブ',0.221,15.18,2.84,'Peg'),
 ('アルヘナ',6.629,16.40,1.92,'Gem'),('メンカリナン',5.992,44.95,1.90,'Aur'),
 ('εBoo',14.750,27.07,2.37,'Boo'),('ηBoo',13.911,18.40,2.68,'Boo'),
 ('ラサルハゲ',17.582,12.56,2.08,'Oph'),('ζAql',19.090,13.86,2.99,'Aql'),
 ('θAql',20.188,-0.82,3.24,'Aql'),('シェリアク',18.834,33.36,3.52,'Lyr'),
 ('スラファト',18.982,32.69,3.24,'Lyr'),
 ('ミラ',2.322,-2.98,3.04,'Cet'),('ディフダ',0.726,-17.99,2.04,'Cet'),
 ('アルフェッカ',15.578,26.71,2.23,'CrB'),('カペラ南のι Aur',4.950,33.17,2.69,'Aur'),
 ('θAur',5.995,37.21,2.65,'Aur'),
]
# 星座線: 星名インデックス参照で定義(主要20)
NAME2IDX = {s[0]: i for i, s in enumerate(STARS)}
def L(*names):
    return [NAME2IDX[n] for n in names]
CONST = {
 'Ori': {'n':'オリオン座','lines':[L('ベテルギウス','ベラトリクス'),L('ベラトリクス','ミンタカ'),
   L('ミンタカ','アルニラム'),L('アルニラム','アルニタク'),L('アルニタク','ベテルギウス'),
   L('ミンタカ','リゲル'),L('アルニタク','サイフ'),L('サイフ','リゲル')]},
 'UMa': {'n':'北斗七星','lines':[L('ドゥーベ','メラク'),L('メラク','フェクダ'),L('フェクダ','メグレズ'),
   L('メグレズ','アリオト'),L('アリオト','ミザール'),L('ミザール','アルカイド'),L('メグレズ','ドゥーベ')]},
 'Cas': {'n':'カシオペヤ座','lines':[L('カフ','シェダル'),L('シェダル','ツィー'),L('ツィー','ルクバー'),L('ルクバー','セギン')]},
 'Cyg': {'n':'はくちょう座','lines':[L('デネブ','サドル'),L('サドル','アルビレオ'),L('サドル','ギェナー'),L('サドル','δCyg')]},
 'Sco': {'n':'さそり座','lines':[L('βScoの','βSco') if False else L('βSco','δSco'),L('δSco','アンタレス'),
   L('アンタレス','ζSco'),L('ζSco','サルガス'),L('サルガス','シャウラ')]},
 'Leo': {'n':'しし座','lines':[L('レグルス','アルギエバ'),L('アルギエバ','ゾスマ'),L('ゾスマ','デネボラ'),L('デネボラ','レグルス')]},
 'Gem': {'n':'ふたご座','lines':[L('カストル','ポルックス'),L('ポルックス','アルヘナ')]},
 'Aur': {'n':'ぎょしゃ座','lines':[L('カペラ','メンカリナン'),L('メンカリナン','θAur'),L('θAur','エルナト'),
   L('エルナト','カペラ南のι Aur'),L('カペラ南のι Aur','カペラ')]},
 'Boo': {'n':'うしかい座','lines':[L('アークトゥルス','εBoo'),L('アークトゥルス','ηBoo')]},
 'Lyr': {'n':'こと座','lines':[L('ベガ','シェリアク'),L('シェリアク','スラファト'),L('スラファト','ベガ')]},
 'Aql': {'n':'わし座','lines':[L('アルタイル','ζAql'),L('アルタイル','θAql')]},
 'Peg': {'n':'ペガスス座(秋の四辺形)','lines':[L('マルカブ','シェアト'),L('シェアト','アルフェラッツ'),
   L('アルフェラッツ','アルゲニブ'),L('アルゲニブ','マルカブ')]},
 'And': {'n':'アンドロメダ座','lines':[L('アルフェラッツ','ミラク'),L('ミラク','アルマク')]},
 'Tau': {'n':'おうし座','lines':[L('アルデバラン','エルナト')]},
 'UMi': {'n':'こぐま座','lines':[]},
 'CMa': {'n':'おおいぬ座','lines':[]},
 'CMi': {'n':'こいぬ座','lines':[]},
 'Vir': {'n':'おとめ座','lines':[]},
 'CrB': {'n':'かんむり座','lines':[]},
 'Cet': {'n':'くじら座','lines':[]},
}
# ---------------- 圧縮出力 ----------------
# app側は CORE.decodePoly / CORE.decodeEle をそのまま使えるので、新しいデコーダは要らない。
# JSONの生配列だと 88星座ぶんで23KBを超えた(等級カットを下げても頂点用へ移るだけで減らない)。
def _enc(v, out):
    v = (v << 1) if v >= 0 else ~(v << 1)
    while v >= 0x20:
        out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
    out.append(chr(v + 63))

def enc_pairs(pairs):
    """(ra時, dec度) を 1e5 固定小数の折れ線として符号化(CORE.decodePolyで戻る)"""
    out, pa, pb = [], 0, 0
    for (a, b) in pairs:
        ia, ib = round(a * 1e5), round(b * 1e5)
        _enc(ia - pa, out); _enc(ib - pb, out); pa, pb = ia, ib
    return ''.join(out)

def enc_ints(vals):
    """整数列を差分符号化(CORE.decodeEleで戻る)"""
    out, p = [], 0
    for v in vals:
        v = int(v); _enc(v - p, out); p = v
    return ''.join(out)

def pack(label_rows, vertex_rows, cons):
    """label_rows: [(名前, ra, dec, mag)] / vertex_rows: [(ra, dec, mag)]
       cons: {略号: (和名, [(i, j), ...])} — 添字は label+vertex の連結空間"""
    allpts = [(r[1], r[2]) for r in label_rows] + [(r[0], r[1]) for r in vertex_rows]
    allmag = [round(r[3] * 10) for r in label_rows] + [round(r[2] * 10) for r in vertex_rows]
    nm = {}
    for i, r in enumerate(label_rows):
        if r[0]: nm[str(i)] = r[0]
    c = {}
    for ab, (ja, segs) in sorted(cons.items()):
        flat = []
        for (a, b) in segs: flat += [a, b]
        c[ab] = {'n': ja, 'l': enc_ints(flat)}
    return {'n': len(label_rows), 'nv': len(vertex_rows),
            'p': enc_pairs(allpts), 'm': enc_ints(allmag), 'nm': nm, 'c': c}

# ---------------- 出力 ----------------
SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')

def write_stars(out, note):
    js = ('// ' + note + ' — tools/make_stars.py が生成。手編集しない\n'
          'var STARS = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
    open(os.path.join(SRC_DIR, 'stars.js'), 'w', encoding='utf-8').write(js)
    kb = len(js.encode()) / 1024
    sys.stderr.write(f'stars.js {kb:.1f}KB — {note}\n')
    if kb > 15: sys.stderr.write('⚠ stars.js が目安の15KBを超えた(--mag を下げるか線の少ない星表にする)\n')
    return kb

def curated():
    """引数なしの既定。手書きの精選版(全星がラベル用・頂点専用は空)"""
    rows = [(x[0], x[1], x[2], x[3]) for x in STARS]
    cons = {k: (v['n'], [(l[0], l[1]) for l in v['lines']]) for k, v in CONST.items()}
    return pack(rows, [], cons)

# ---------------- 外部星表(HYG + Stellarium)の投入 ----------------
def emit_fetch():
    print('# 星表と星座線を手元にDLする(このコンテナからは取りに行かない)')
    print('# ライセンス: HYG Database = CC BY-SA(要クレジット・データ部分は継承)')
    print('#             Stellarium 星座線 = GPL系')
    print('# 表示クレジット: 「星表: HYG Database (CC BY-SA) / 星座線: Stellarium」')
    print('set -e')
    print(f'curl -sfSL -o hyg.csv.gz {HYG_URL}')
    print(f'curl -sfSL -o constellations.json {LINES_URL}')
    print('echo "完了: python3 tools/make_stars.py --hyg hyg.csv.gz --lines constellations.json" >&2')
    print(f'# HYGが取れない場合の入手先: {HYG_ALT}')

def _open_text(path):
    """.gz のままでも素のテキストでも開ける"""
    if path.endswith('.gz'):
        import gzip
        return gzip.open(path, 'rt', encoding='utf-8-sig', newline='')
    return open(path, newline='', encoding='utf-8-sig')

def load_hyg(path):
    """HYG CSV → {hip: (ra時, dec度, mag, proper, con)}。列名で拾うので版が変わっても動く"""
    by_hip, rows = {}, 0
    with _open_text(path) as f:
        rd = csv.DictReader(f)
        need = ('ra', 'dec', 'mag')
        if not rd.fieldnames or any(c not in rd.fieldnames for c in need):
            sys.exit(f'--hyg: 列 {need} が見つからない(HYGのCSVか確認): {rd.fieldnames}')
        for r in rd:
            rows += 1
            try:
                ra, dec, mag = float(r['ra']), float(r['dec']), float(r['mag'])
            except (TypeError, ValueError):
                continue
            hip = (r.get('hip') or '').strip()
            if not hip: continue
            try: hip = int(float(hip))
            except ValueError: continue
            by_hip[hip] = (ra, dec, mag, (r.get('proper') or '').strip(), (r.get('con') or '').strip())
    if not by_hip: sys.exit(f'--hyg: HIP番号を持つ行が1つも無い: {path}')
    sys.stderr.write(f'HYG: {rows}行 → HIP付き {len(by_hip)}件\n')
    return by_hip

def load_lines(path):
    """星座線を読む。現行Stellariumの index.json と 旧 constellationship.fab の両方に対応。
       → {略号: [(hip1, hip2), ...]}"""
    head = open(path, encoding='utf-8').read(400).lstrip()
    if head.startswith('{') or head.startswith('['):
        return _load_lines_json(path)
    return _load_lines_fab(path)

def _load_lines_json(path):
    """index.json: constellations[].id = "CON modern Aql" / lines = HIP番号の折れ線の配列"""
    doc = json.load(open(path, encoding='utf-8'))
    cons = doc.get('constellations') if isinstance(doc, dict) else doc
    if not cons: sys.exit(f'--lines: constellations が無い: {path}')
    out = {}
    for c in cons:
        abbr = str(c.get('id', '')).split()[-1]
        if not abbr: continue
        segs = []
        for poly in c.get('lines', []):
            for i in range(1, len(poly)):        # 折れ線 → 連続する2点の線分に展開
                try: segs.append((int(poly[i - 1]), int(poly[i])))
                except (TypeError, ValueError): pass
        out[abbr] = segs
    sys.stderr.write(f'lines(json): {len(out)}星座 / {sum(len(v) for v in out.values())}線分\n')
    return out

def _load_lines_fab(path):
    """旧 constellationship.fab: 「略号 線分数 hip hip hip hip ...」"""
    out = {}
    for ln in open(path, encoding='utf-8'):
        ln = ln.split('#')[0].strip()
        if not ln: continue
        tk = ln.split()
        if len(tk) < 3: continue
        abbr = tk[0]
        try: n = int(tk[1])
        except ValueError: continue
        ids = []
        for t in tk[2:]:
            try: ids.append(int(t))
            except ValueError: pass
        if len(ids) < 2 * n:
            sys.stderr.write(f'⚠ {abbr}: 線分{n}本の宣言に対しHIPが{len(ids)}個しかない(その分は落とす)\n')
            n = len(ids) // 2
        out[abbr] = [(ids[2 * i], ids[2 * i + 1]) for i in range(n)]
    if not out: sys.exit(f'--lines: 星座を1つも読めなかった(index.json か .fab か確認): {path}')
    sys.stderr.write(f'lines(fab): {len(out)}星座 / {sum(len(v) for v in out.values())}線分\n')
    return out

def ja_overrides():
    """手書きの精選表を「和名の上書き辞書」として使う。座標一致(0.05度以内)で当てる"""
    return [(x[0], x[1], x[2]) for x in STARS]

def build_from_external(hyg_path, fab_path, mag_cut):
    hyg, fab = load_hyg(hyg_path), load_lines(fab_path)
    # ① 線の頂点として参照されるHIPを先に集める(等級カットの例外にする対象)
    ref = set()
    for segs in fab.values():
        for a, b in segs: ref.add(a); ref.add(b)
    missing = sorted(h for h in ref if h not in hyg)

    # ② ラベル用 = 等級カット内。名前は和名辞書を最優先、無ければHYGのproper
    ov = ja_overrides()
    def ja_name(ra, dec):
        for (n, r0, d0) in ov:                    # RAは時単位。1時=15度で度に直して比べる
            if abs(ra - r0) * 15.0 < 0.05 and abs(dec - d0) < 0.05: return n
        return None

    label_hips = sorted(h for h, v in hyg.items() if v[2] <= mag_cut)
    s_rows, idx_of, named = [], {}, 0
    for h in label_hips:
        ra, dec, mag, proper, con = hyg[h]
        nm = ja_name(ra, dec) or proper
        if nm: named += 1
        idx_of[h] = len(s_rows)
        s_rows.append((nm, ra, dec, mag))

    # ③ 線の頂点専用 = 参照されているが等級カット外。ここを落とすと線が欠ける
    v_rows = []
    for h in sorted(ref):
        if h in idx_of or h not in hyg: continue
        ra, dec, mag, _p, _c = hyg[h]
        idx_of[h] = len(s_rows) + len(v_rows)          # 連結インデックス空間
        v_rows.append((ra, dec, mag))

    # ④ 線。解決できないHIPを含む線分だけ落とし、何本落としたか必ず報告する
    c_out, dropped = {}, 0
    for abbr, segs in sorted(fab.items()):
        ll = []
        for a, b in segs:
            if a in idx_of and b in idx_of: ll.append((idx_of[a], idx_of[b]))
            else: dropped += 1
        c_out[abbr] = (CONST_JA.get(abbr, abbr), ll)

    sys.stderr.write(
        f'ラベル用 {len(s_rows)}星(≤{mag_cut}等・和名/固有名あり {named}) / '
        f'線の頂点専用 {len(v_rows)}星(等級カット外) / {len(c_out)}星座\n')
    if missing:
        sys.stderr.write(f'⚠ fabが参照するHIPのうち {len(missing)}件が星表に無い '
                         f'(例: {missing[:8]}) → その線分{dropped}本は描かない\n')
    elif dropped:
        sys.stderr.write(f'⚠ 線分{dropped}本を落とした\n')
    else:
        sys.stderr.write('fabの参照HIPはすべて解決した(線は欠けない)\n')
    no_ja = [c for c in c_out if c not in CONST_JA]
    if no_ja: sys.stderr.write(f'⚠ 和名が無い星座略号: {no_ja}\n')
    return pack(s_rows, v_rows, c_out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--emit-fetch', action='store_true', help='星表/星座線のDLスクリプトを出力して終了')
    ap.add_argument('--hyg', default=None, help='HYG Database CSV (CC BY-SA)')
    ap.add_argument('--lines', default=None, help='Stellarium の index.json か旧 constellationship.fab (GPL系)')
    ap.add_argument('--mag', type=float, default=3.5, help='ラベル用の等級カット (既定3.5 ≒ 300星)')
    a = ap.parse_args()

    if a.emit_fetch: emit_fetch(); return
    if bool(a.hyg) != bool(a.lines):
        sys.exit('--hyg と --lines は両方指定する(星座線だけ/星表だけでは線が引けない)')
    if a.hyg:
        out = build_from_external(a.hyg, a.lines, a.mag)
        note = (f'HYG Database (CC BY-SA) {out["n"]}星 + 線の頂点用{out["nv"]}星 / '
                f'星座線 Stellarium (GPL) {len(out["c"])}星座')
    else:
        out = curated()
        note = f'精選星表(輝星{out["n"]}+星座{len(out["c"])})'
    write_stars(out, note)

if __name__ == '__main__':
    main()
