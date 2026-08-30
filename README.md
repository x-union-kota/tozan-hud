# 登山HUD (tozan-hud) v3.2

Meta Ray-Ban Display(HUD + Neural Band)向けの登山/ランHUD。CDN・外部依存ゼロの単一HTML Webアプリ。

- 公開版: https://x-union-kota.github.io/tozan-hud/
- PCブラウザ検証: 上記URL に `?sim=1` を付ける(シミュレータモード)

## セットアップ

```bash
npm install jsdom                 # jsdom統合テスト用
python3 tools/build.py            # src/* → dist/index.html
node test/core.test.js            # 純ロジック 89件
node test/app.smoke.js            # jsdom統合 74件
python3 test/gpx2route.test.py    # 変換ツール 75件
```

3スイート全通過(89 + 74 + 75 = 238件)を確認してから作業を始める。

## 公開(GitHub Pages)

GitHub Pages はリポジトリ直下を配信元にしているため、ビルド後に成果物をルートへコピーする。

```bash
python3 tools/build.py && cp dist/index.html index.html && cp dist/sw.js sw.js
```

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| `CLAUDE.md` | 守るべき制約・コマンド・設計思想(作業前に毎回読む) |
| `docs/HANDOFF.md` | 実装状況・残タスク・実機で確定済みの既知事実 |
| `docs/meta-display-dev-guide.md` | 画面・入力・配色の5原則 |

## 構成

```
src/     アプリ本体(core.js 純ロジック / app.js アプリ層 / astro.js 天文計算)
         routes.js・stars.js は自動生成のため手編集しない
tools/   build.py(単一HTML組み立て)・gpx2route.py(実GPX→v3ルート変換)ほか生成スクリプト
test/    3スイート
dist/    ビルド成果物
```
