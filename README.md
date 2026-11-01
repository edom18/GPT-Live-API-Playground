# GPT-Live Lab

GPT-Live (`gpt-live-1`) のclient委譲と発話を観測する、localhost用Playgroundです。画面モックは `design/`、実装は `public/` と `server.mjs` にあります。

## 起動

Node.js 22.15以降が必要です。プロジェクト内で実行します。

```powershell
Copy-Item .env.example .env
# .env の OPENAI_API_KEY を自分で設定
npm ci
npm start
```

WindowsでNodeがPATHにない場合、この環境の既存Nodeを使う `./start.ps1` でも起動できます。ブラウザで http://localhost:3210 を開いてください。ポート変更は `.env` の `PORT` で指定します。

APIキーの設定後はサーバーを再起動してください。実際のAPI呼び出しは画面の「最新設定で接続」から開始します。モデル利用権限がない場合は接続エラーを表示します。キーをチャットや画面へ貼る必要はありません。

## 最初の実験

1. 初期instructions、音声、遅延、手動/自動モードを設定します。
2. 「委譲JS」でプリセットを選んで「適用」。模擬待機時間と返却内容を設定します。
3. 「最新設定で接続」を押し、Live接続中になったらマイクをONにして調査を依頼します。
4. 委譲イベントを受信すると、そのIDでコードを起動します。手動モードではカードの「次へ」でcheckpointを再開します。
5. 待機中に「差し込み」から各appendを `delegation_id:null` で送ります。ID付き送信は委譲コードで行います。
6. 下部のログからイベントを選ぶと、その時点の送信内容と確認状況を表示します。「現在へ」で戻ります。
7. JSON / Markdownで実験を出力します。保存済み実験から閲覧・設定復元もできます。
8. 終了時は切断します。ブラウザの制御接続が失われた場合もLiveを切断し、Workerを終了します。

編集内容は700msのデバウンス後 `data/draft.json` へ保存します。リロードはLive接続を終了します。コード変更は次回接続から適用します。各接続の設定とコードは固定スナップショットを残します。1つのサーバーにつき同時実験は1つです。

## 初期instructionsの保存

接続設定で初期instructionsを入力し、保存名を付けて「名前を付けて保存」を押すと、複数の内容をこのブラウザのlocalStorageに保存できます。保存済み一覧から選んで「読み込む」と、初期instructionsだけを復元します。反映は次回接続からです。同名での上書きはせず、修正版は別名で保存してください。「削除」は保存済み項目だけを削除し、編集中の内容は残します。

ブラウザデータの消去で保存内容も消えます。別のブラウザ・URL・ポートとは共有されません。既存の編集中設定の自動保存（`data/draft.json`）とは別の機能です。

## カスタム音声（Prompt to voice）

接続設定の「カスタム音声を作成する」で専用モーダルを開き、名前・声の説明・任意のサンプル台詞を入力して作成します。Node側から `POST /v1/audio/voices` に `type: prompt` / `model: auto` で送信し、返されたIDと元の説明を `data/voices/` に保存します。作成は明示的にボタンを押した場合だけ行い、通信失敗時に自動再試行しません。

保存済みの音声を選んで「声に設定」を押すと接続設定にIDを入れます。送信時は `session.audio.output.voice: { id: "voice_..." }` になります。「声の説明を初期指示に追記」も利用してください（公式推奨）。追記内容は通常のinstructionsエディタで確認でき、別の声へ切り替えるときは前の説明を削除・編集できます。設定の反映には接続・再接続が必要です。

作成APIは音声プレビューを返しません。試聴はLive接続で行います。声はAI生成です。保存済み一覧はこのPlaygroundのローカル保存分で、OpenAI上の全音声を同期する機能ではありません。既知のvoice IDは接続設定へ直接入力して再利用することもできます。`data/` はGitの対象外です。APIキーのプロジェクトを変えた場合は、そのプロジェクトで利用できるIDを選んでください。

参考: https://developers.openai.com/api/docs/guides/custom-voices

## コード編集

編集欄にはCodeMirrorを使用しています。委譲JSはJavaScript、JSON欄はJSONとして構文を色分けし、行番号・括弧補完・インデント・検索・Undo/Redoを利用できます。上部の「Vimモード」はプロンプト欄も含む編集欄全体に適用し、このブラウザに設定を保存します。Vimでは `i` で入力、`Esc` で通常モード、`/` で検索、`:` でコマンド入力ができます。Vim操作は接続やコードの適用タイミングを変えません。委譲JSは従来どおり次の接続から反映します。

エディタ資源はローカル配信です。`npm start` と `start.ps1` は起動前に `npm run build` を実行します。エディタ読込に失敗した場合は通常のテキスト欄へフォールバックします。

接続設定タブの「送信コードを見る」から読み取り専用モーダルを開けます。「編集中の設定」は現在ロードされた設定組み立て関数と実際のNode送信関数、未送信のsession引数を表示します。「表示中の実験」は実験開始時に保存したコードとSHA256、実際のsession.start送信ログ、session.started受信ログを表示します。更新前の実験でコード記録がない場合は、その旨を表示します。キーの値は含めません。閲覧はAPI通信を起動しません。

```js
export async function onDelegation(event, ctx) {
  const id = event.delegation.id;
  ctx.log('開始', { id, transcript: ctx.transcript });
  await ctx.send({
    type: 'session.thinking.append',
    delegation_id: id,
    content: '',
  });
  await ctx.checkpoint('調査前');
  await ctx.sleep(ctx.parameters.waitMs);
  await ctx.send({
    type: 'session.commentary.append',
    delegation_id: id,
    content: ctx.parameters.result,
  });
}
```

- `send(event)` はevent_id省略時にUUIDを付与し、ソケット送信後にresolveします。API受理や発話完了を待つ関数ではありません。
- `log(...values)` は委譲ID付きで記録します。consoleのlog/info/warn/errorもログへ送ります。
- `checkpoint(name)` は手動で待機、自動で通過。Liveの会話や自動応答は停止しません。
- `sleep(ms)` はNodeのPromiseタイマーです。
- `transcript` は委譲開始時点の入力・出力文字起こしです。委譲イベント自体にタスク本文はありません。
- `parameters` は接続時の待機時間・模擬結果です。
- NodeのWorkerで任意JavaScriptを実行するため `fetch`、`process.env`、`node:` import等を使用できます。これは不審なコードを安全に実行するサンドボックスではありません。接続前のexport検証でモジュールを一度評価するため、外部通信等の副作用はトップレベルではなくonDelegation内に書いてください。パッケージimportはdata URLモジュールの制約があるので、必要なら `createRequire` 等で解決してください。
- 中止・切断ではWorkerを終了。送信済み要求や外部システムで開始済みの処理を取り消すものではありません。

## テキスト入力とAPI上の制約

通常のRealtime APIの `conversation.item.create` 等は使いません。確認したLive primary WebSocket仕様には接続中の一般ユーザーテキスト投稿イベントがないため、次の区別を画面に表示しています。

- 接続前: `session.input` のuserメッセージとして初期テキスト履歴を設定。
- 接続中: テキストは `session.thinking.append` の一般コンテキストとして送信。マイクによるユーザー発話とは異なります。
- JSONエディタ: appendのほか、`session.update` のclient遅延更新、音声入力mute/unmute、`session.close` をテンプレート化。未知のtypeも試せますがAPIが対応を判断します。
- 初期instructions、音声、モデルは接続中に置換できません。初期設定を変えて再接続します。
- appendの500トークン制限はAPIで検証します。文字数をトークン数とみなすチェックはしていません。

## ログ・音声・状態

ブラウザとNode、NodeとLiveの2本のWebSocketを使用。音声はmono PCM16LE/24kHz、マイクはAudioWorkletで変換します。マイクOFF時はNodeが20msごとに無音を供給し、セッション時間を進めます。マイクONでも入力が間に合わないフレームは無音です。出力はWeb Audioで順番に再生し、予定時刻と終了コールバックを記録します。音声デバイスから実際に聞こえた時刻を測るものではありません。

各イベントはサーバー受信順の連番、実験開始からの単調時計、壁時計時刻を記録します。APIのstart_ms/end_msとブラウザのperformance時刻は別の時計です。API受信までの差はネットワーク・サーバー処理を含みます。音声フレームと再生イベントは初期状態で非表示。フィルター後の最新300件を画面に表示し、保存と出力には全件を含めます。

`data/<run-id>.json` は設定・コード・ハッシュ、`.jsonl` はイベントです。音声本体は保存せずバイト数のみ。既知の秘密フィールド、sk形式の文字列、KEY/TOKEN/SECRET/PASSWORDを含む環境変数の値をマスクします。独自ログへ書いた未知の秘密や個人情報の自動検出は保証しません。記事公開前は出力内容を確認してください。

状態インスペクターは初期設定、append履歴、対応するclient_event_idの確認、文字起こしを再構成します。未確認を確認済みにはせず、エラーも紐付けます。圧縮後のモデル内部状態・完全な実効プロンプトは取得していません。ローカル処理の完了をLive側の委譲完了とは表示しません。

## 検証

```powershell
npm run check
npm test
```

模擬WebSocket APIとの統合テスト、複数委譲のcheckpoint分離、キャンセル、自動モード、コード構文エラー、過去時点の再構成、認証情報・音声除外、Origin/Host制限を検証します。OpenAI APIへは接続しません。

実際のキーによる接続・マイク・発話は未検証です。手動確認は、上記「最初の実験」に加え、音声割り込み、再接続後の古いWorker停止、APIエラー時のログ、500トークン超過、空thinkingの有無による違いを確認してください。既存の静的デザインとは異なり、実装にはサンプル発話を自動挿入しません。

## 公式仕様（2026-10-31確認）

- https://developers.openai.com/api/reference/resources/live/primary-websocket
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/voice-websockets?api=live

`docs/primary-websocket.md` に参照時点の公式Markdownを保存しています。

## 無発話時の安全切断

session.started受信後、ユーザーの発話を1分間確認できなければ、サーバーからsession.closeを送り、委譲処理と音声送信を停止します。APIの終了確認が5秒以内に返らない場合はソケットを強制終了します。非空のsession.input_transcript.deltaを受信するたびに1分のタイマーを更新します。AIの発話、マイクON、無音フレーム、テキスト差し込み、ボタン操作では延長しません。文字起こしに遅延・欠落がある場合は、実際に話していても切断される可能性があります。判定はブラウザではなくNode側で行い、切断理由はログに残します。
