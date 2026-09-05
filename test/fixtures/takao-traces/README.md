# 高尾山 実歩行ログ(OSM 公開GPSトレース)

出典: OpenStreetMap 公開 GPS トレース(trackpoints API `bbox=139.235,35.615,139.280,35.640`、2026-09-05 取得、161本中
時刻付き単調 86本)。`tools/osm_traces.py --anywhere --near 300 --dem-tiles dem/` で「高尾山口駅近傍を通って山頂に達した」
6本を選別し、`<ele>` の無い API 応答に地理院 DEM(dem_png z14)の標高を付けて書き出したもの。
© OpenStreetMap contributors (ODbL) / 標高: 地理院タイル。

用途: 標準CT式(登り300m/h+水平4km/h、下り500m/h+水平4.5km/h)に対する実測倍率の回帰テスト(`test/gpx2route.test.py [osm-traces]`)。
再現: `python3 tools/osm_traces.py test/fixtures/takao-traces --start 35.6322,139.2699 --goal 35.6252,139.2436 --near 300 --anywhere --min-pts 80`(50m間隔に打ち直し済みなので点数の下限を下げる)
