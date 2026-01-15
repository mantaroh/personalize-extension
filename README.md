# パーソナライズブラウザ拡張

このプロジェクトは、閲覧履歴やユーザー操作に応じてウェブページの表示をパーソナライズするブラウザ拡張のベース実装です。Chrome / Firefox / Safari の各ブラウザで動作できるように WebExtension を構成しています。

## ディレクトリ構成

```
extension/
├── background/
│   └── background.js     # 非同期タスクを扱うサービスワーカー
├── content/
│   └── content-script.js # ユーザー操作を監視しページに反映
└── manifest.json          # Chrome / Safari 向けマニフェスト
└── manifest.firefox.json  # Firefox 向けマニフェスト
```

## 機能概要

- **非同期バックグラウンド処理**: `background.js` は、ユーザー操作をキューに積んで順番に処理し、定期的な同期タスク（`browser.alarms`）も実行します。
- **操作記録の取得**: `content-script.js` がクリック・スクロールを検知し、現在のタブ URL と共にバックグラウンドへ送信します。
- **ページのパーソナライズ**: 保存した統計情報に応じてページにハイライト色を適用するサンプルロジックを実装しています。

## 開発 / 動作確認

### Chrome
1. Chrome を開き、 `chrome://extensions` を表示します。
2. 「デベロッパーモード」を有効化します。
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、`extension/` ディレクトリを選択します。

### Firefox
1. Firefox を開き、 `about:debugging#/runtime/this-firefox` を表示します。
2. Firefox はマニフェストファイル名が `manifest.json` でないと読み込めないため、Firefox 用にコピーしたフォルダを用意します（例: `cp -R extension extension-firefox`）。
3. `extension-firefox/manifest.json` を `extension/manifest.firefox.json` で上書きし、`extension-firefox/manifest.firefox.json` は削除します。
4. 「一時的なアドオンを読み込む」をクリックし、`extension-firefox/manifest.json` を指定します。
5. それでも `background.service_worker is currently disabled. Add background.scripts.` が出る場合は、以下の手順で原因を切り分けてください。
   1. `about:debugging#/runtime/this-firefox` で対象アドオンの「詳細」→「マニフェストを表示」を開き、`manifest_version: 2` と `background.scripts` が表示されるか確認します（表示内容が期待と違う場合、別ファイルを読み込んでいます）。
   2. 同じ画面の「検査」→「アドオンデバッガー」を開き、コンソールに `manifest_version` や `background` に関する警告が出ていないか確認します。
   3. `about:debugging#/runtime/this-firefox` の「拡張機能のエラー」に、`service_worker` に関するメッセージが出ていないか確認します（どのファイルが原因と出るかを記録してください）。
   4. `extension-firefox/background/background.js` が読み込み対象のフォルダに存在するか確認し、パスが `background/background.js` と一致しているか確認します。

## CI で生成された Zip アーカイブの利用手順

CI から配布される Zip ファイルは、Chrome / Safari 用と Firefox 用の 2 種類を用意します（Firefox は `manifest.json` というファイル名でしか読み込めないため、`manifest.firefox.json` を `manifest.json` に差し替えたフォルダを別途パッケージ化します）。

### 事前準備（共通）
1. Chrome / Safari 用 Zip と Firefox 用 Zip をそれぞれダウンロードします。
2. Zip を展開し、各フォルダの直下に `manifest.json` がある構成のまま保持します（移動や削除を行うと読み込み済みの拡張機能が無効化されるため注意してください）。

### Google Chrome
1. Chrome で `chrome://extensions` を開きます。
2. 右上の「デベロッパーモード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、Zip を展開したフォルダ（`manifest.json` が直下にあるディレクトリ）を選択します。

### Mozilla Firefox
1. Firefox で `about:debugging#/runtime/this-firefox` を開きます。
2. 「一時的なアドオンを読み込む」をクリックし、Firefox 用 Zip を展開したフォルダ内の `manifest.json` を指定します。
3. 一時アドオンとして読み込まれるため、ブラウザ再起動後に継続利用したい場合は `web-ext` などで署名パッケージ化するか、再度読み込みを実施してください。

### Microsoft Edge
- Chromium ベースのブラウザのため、基本的には Chrome と同じ手順で読み込めます。
  1. Edge で `edge://extensions` を開き、左下の「デベロッパー モード」をオンにします。
  2. 「展開されていない拡張機能を読み込む」をクリックし、Zip を展開したフォルダを指定します。
- CI で署名済みパッケージ（`.crx` など）を配布する運用を行う場合は、企業ポリシーや Edge アドオン ストア経由での配布も検討してください。

### Apple Safari
- Safari では WebExtension をそのまま読み込むことができません。Zip を展開した後、Xcode の「Convert Web Extension」機能を利用して Safari App Extension プロジェクトを生成し、署名付きでビルドする必要があります。
- テスト目的であれば、Xcode から Safari を実行し、開発メニューを有効化して動作確認する方法が簡便です。

## 今後の拡張

- ユーザーごとの詳細な嗜好分析の実装
- サーバーと連携した履歴同期
- オプションページ / UI の追加
