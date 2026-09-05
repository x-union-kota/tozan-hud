# 実ルート(data/real)

`*.json` は `tools/gpx2route.py --dump-json` の出力そのもので、`tools/make_field_demo.py` が読んで
`src/routes.js` に載せる(`real: true` の付いたルートは `make_registry.py` が触らない)。

| id | 出典 | 変換元 |
| --- | --- | --- |
| takao | OSM 公開GPSトレース 2011-03-27(高尾山口→1号路→山頂→高尾山口、7.7km +419m) | `takao.gpx`(`test/fixtures/takao-traces/trace_03.gpx` に WP を付けたもの) |
| fuji | OSM 公開GPSトレース 2014-08-15(吉田ルート 五合目→頂上の登り区間、5.1km +1361m) | `fuji.gpx`(`osm_traces.py --anywhere` で選別 → 登り区間を切り出し) |
| minamitakao | 実GPX(TrailNote, 2019-07-09、高尾山口起点の南高尾山稜 周回、8.1km +434m) | `minamitakao.gpx` |

トレースは © OpenStreetMap contributors (ODbL)。標高は GPX 自身の値(富士・南高尾)または地理院 DEM(高尾。
trackpoints API は `<ele>` を返さないので `osm_traces.py --dem-tiles` で付けた)。峰の可視判定は地理院 DEM z12 の
レイキャスト、偏角は WMM2025(2026-08-31 基準)。

## 再生成

```bash
# 1. OSM(POI・道路ベクタ・吸着材料)と DEM(可視判定)を手元に取る
python3 tools/gpx2route.py data/real/takao.gpx --emit-query > q.txt
curl -sG https://overpass-api.de/api/interpreter --data-urlencode data@q.txt > data/real/osm/osm_takao.json
python3 tools/gpx2route.py data/real/takao.gpx --emit-dem-fetch > fetch_dem.sh && sh fetch_dem.sh   # dem/ (z12・約80枚)

# 2. 変換(WMM係数 zip は NOAA から。--date は偏角の基準日)
python3 tools/gpx2route.py data/real/takao.gpx --id takao --name "高尾山 1号路 往復" \
    --osm data/real/osm/osm_takao.json --dem-tiles dem/ --wmm WMM2025COF.zip --date 2026-08-31 \
    --dump-json data/real/takao.json > /dev/null

# 3. routes.js を作り直す
python3 tools/make_field_demo.py && python3 tools/make_registry.py --wmm WMM2025COF.zip --date 2026-08-31 && python3 tools/build.py
```

富士・南高尾も同じ(`--name` は「富士山 吉田ルート」「南高尾山稜 周回」)。OSM JSON は `osm/` に置いてある。
DEM タイルはサイズの都合でリポジトリに入れていない(スクリプトで取り直す)。

## 注意

- 実GPX は `--snap-osm`(既定)で OSM の登山道へ吸着する。`--route-osm`(概形用の経路探索)は使わない:
  南高尾で実測、吸着 8.1km(-3%、平均ずれ 5m)に対し経路探索は 11.6km(+40%)に膨らんだ
- `<wpt>` の `type=start` は沿道距離 0、`goal` は終点に固定される(往復・周回では起点と終点が同じ座標)
- 峰の上限(`--max-reg 80`)は峰にだけ効く。駅・小屋・温泉などの POI は落とさない
