# GPT-Live Playground — デザインレビュー

`index.html` をブラウザで開くと操作可能な画面モックを確認できます。API接続、マイク取得、任意コード実行は行いません。表示するイベントと発話はすべて架空のサンプルです。

## 合意した要件
- localhostで利用。APIキーと編集JavaScriptはNode.js側で管理・実行。
- 最新の設定・コードで接続。コード変更は次回接続に反映。
- マイク・音声再生・テキスト入力と利用可能な文字起こし。
- instructions / commentary / thinkingのappendと、その他の公式操作用JSONエディタ。
- 一般差し込みはdelegation_id:null。委譲処理は受信したIDを自動使用。任意ID入力欄なし。
- log()とawait checkpoint(name)。手動では委譲ごとに再開、自動では通過。
- 初期委譲処理は指定時間待って固定結果を返す。外部処理へ書き換え可能。
- 何も送らない／空thinking／即時commentaryのコードプリセットと自動応答遅延設定。
- 複数委譲を独立実行。ログへIDを関連付け。
- 現在と過去時点の状態・差分。送信、API確認、発話、再生を区別。
- 実験の設定・コード・イベント・独自ログ・文字起こしを保存しJSON／Markdown出力。秘密情報・音声録音は除外。

## 画面の意図
上部で接続状態と実行中の設定版を確認。左側で次回接続の設定とコード、即時送信する差し込みを編集。中央で会話・音声と各委譲を操作。右側で確認できたコンテキストを表示し、下部のイベント選択で過去時点へ移動。

モックの「接続前」「委譲待機中」「差し込み後」で代表状態を切替可能。編集タブ、委譲の次へ、差し込み、ログ選択、JSON/Markdown出力は画面レビュー用の模擬操作です。リロードで初期表示へ戻ります。

## 実装時に確定する事項
接続方式ごとのイベント対応、session.update等の可変項目、音声再生の計測方法、コンテキスト圧縮後の表示範囲を公式仕様と照合する。表示をモデル内部の完全なプロンプトと断定しない。手動checkpointはLive側の発話を停止しない。ローカル処理完了とAPI側の委譲状態を同一視しない。

## 参照
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/reference/resources/live/fork-websocket
- ユーザー提供: gpt_live_delegation_speech_handoff.md

デザインレビュー後に実装へ進む。
