# CLAUDE.md — 登山HUD (Meta Ray-Ban Display Webアプリ)

Meta Ray-Ban Display(HUD+Neural Band)向けの登山/ランHUD。単一HTMLのWebアプリ。
**必読**: `docs/HANDOFF.md`(実装状況・残タスク・実機で確定済みのプラットフォーム既知事実)と
`docs/meta-display-dev-guide.md`(画面・入力・配色の5原則)。体験設計書 `tozan-hud-experience-design.md` が
別途渡されていればそれが「なぜこう動くべきか」の根拠文書。

## コマンド

```bash
python3 tools/build.py            # src/* → dist/index.html (単一HTML組み立て)
node test/core.test.js            # 純ロジック 156件
node test/app.smoke.js            # jsdom統合 149件 (要: npm install jsdom / dist を先にビルド)
python3 test/gpx2route.test.py    # 変換ツール 94件

cp dist/index.html index.html && cp dist/sw.js sw.js   # 公開用コピー(GitHub Pages はリポジトリ直下を配信)
```

**編集後は必ず build → 3スイート全通過を確認してから完了とする。**
デモルートのデータを触ったら `tools/make_field_demo.py` → `make_registry.py` → `make_stars.py` の順で再生成してから build。

## 絶対に守る制約(実機で確定済み・違反すると動かない)

1. **単一HTMLファイル・CDN/外部依存ゼロ**。画像はbase64埋め込み
2. **600×600固定・`overflow:hidden`・背景純黒 `#000`**(加算ディスプレイでは黒=透明。暗い色は消える。グレー階調やグラデーションで情報を区別しない)
3. **入力は6つだけ**: ←→↑↓ / Enter(人差し指ピンチ) / Escape(中指ピンチ)。モード変数で文脈別に多重化。Escapeは常に「1つ戻る」
4. 最小フォント18px。長押し・同時押しは前提にしない
5. **PCブラウザ(`?sim=1`)で全て検証し、実機は最後の1回**。実機でしか分からないのは視認性・方位の体感・ジェスチャーの3点のみ
6. センサー権限・方位変換・watchPosition停止などの実機特有の罠は `docs/HANDOFF.md` §4 に列挙。**該当コードを触る前に必ず読む**

## 設計思想

- **正直さゲート**: 確信がなければ表示しない/発火しない(ゴースト消灯条件、ラップの進行方向ゲート、可視峰は手動確証のみ実線、古いGPSの数字を出さない、等)。新機能もこの思想に合わせる
- 状態は単一オブジェクト `S` に集約し `render()` 一箇所で反映。`window.__THUD` にテスト用フックを露出
- localStorage は必ず try-catch。保存失敗=リセットで済む設計

## ファイル構成

```
src/core.js    純ロジック(距離・マッチャー・逸脱FSM・周回回転) — node直require可
src/app.js     アプリ層(画面・状態・入力)。最大のファイル
src/astro.js   天文計算(既知値と照合済み。触るなら要再照合)
src/routes.js  src/stars.js  自動生成。手編集禁止(星表は make_stars.py --emit-fetch → --hyg/--lines)
tools/build.py         単一HTML組み立て
tools/gpx2route.py     実GPX→v3ルート変換(OSM/DEMのオフライン投入・--emit-query / --emit-dem-fetch)
dist/index.html dist/sw.js   ビルド成果物
./index.html ./sw.js         dist からの公開用コピー。GitHub Pages(Public)の配信元
```

## 残タスク(優先度順・詳細は HANDOFF.md §1)

HANDOFF §1 の残タスクは **v3.2 で全て消化した**。

- データソース改定(`docs/DATA_SOURCES.md` 優先1〜4)完了。新しい外部データを足すときは、
  そこに書いた「手元DL → ツール投入」の型に合わせること
- 検証チェーン⑥⑦は `docs/VERIFICATION.md` に手順書化した。天文・ゴーストまわりを触ったら通す

コンテナ/サンドボックスから Overpass API・DEMタイル等への外部アクセスは不可の前提で、
「ユーザーが手元でダウンロード → ツールに投入」のオフライン2段構えを維持すること(gpx2route.py が前例)。
