# 外部単発予約の公開経路確認（2026-09-09）

## 結論

外部Hachiプロセスから **現在のDesktop会話に予約を作成する公開API/CLIは、今回の確認範囲では見つからなかった**。不存在の証明ではない。先行運用は、dispatchを行うDesktopオーケストレーターが、会話内の公式 `automation_update` で完了見込み時刻に1回だけ復帰を予約する方式が妥当。

会話内ツールによる一回限定保存と16:20:09の同一会話復帰は親タスクの既実験。今回の調査は再実験していない。外部イベントによる直接wakeとは区別する。

## 根拠と確認範囲

- [公式 Scheduled tasks](https://developers.openai.com/codex/app/automations) を取得。現行ページはChatGPT/Codexの会話内から予約を作成・更新でき、既存会話への復帰、分単位の追跡、終了・人間判断条件をpromptに含めることを説明する。外部automation REST/CLIは記載されていない。ローカル作業にはコンピューターとDesktopアプリの稼働が必要。
- インストール済み `codex-cli 0.153.0` の `codex --help`、`codex queue --help`、`codex app-server --help` を確認。schedule/automationサブコマンドはない。
- `codex app-server generate-json-schema --experimental` の公開生成機能でschemaを生成し、`ClientRequest.json` を検索。automation/scheduledメソッドは見つからず、`thread/queue/add` / `thread/queue/start` は存在。これは生成したバージョンの公開schemaの確認であり、Desktop内部APIの探索ではない。
- [公式 App server](https://developers.openai.com/codex/app-server) は `thread/resume`、`turn/start` による外部クライアント統合を説明する。既存Desktop所有の会話へ別app-serverで安全に接続できるという根拠にはならない。
- Hachi契約 §50.4 はCLI awaitの生存を終了済みDesktop会話のwake経路と扱わず、公式面の予約とdurable状態を区別している。今回§50.4をユーザー採択の単発予約運用へ更新した。

### queue候補の限界

公開 `codex queue --thread <UUIDまたは名前> --message <TEXT>` は既存sessionへメッセージをqueueするCLIで、`--remote` による明示接続もある。しかしhelpには現在のDesktop ownerの発見・接続方法も、idle Desktopへの即時wake保証もない。schemaのqueue追加と開始は別メソッドであり、queue追加成功を生成開始の証拠にしない。親側調査では既定shared daemonに接続できていないため、現時点の採用条件を満たさない。

送信・別app-serverへのresume・非公開socket探索・アプリbundle逆解析・実予約の作成は行っていない。

## dispatch時に1回予約する運用案

同じ担当identity/会話につき有効な予約は1つとし、複数workerの見込みをまとめる。例えば完了見込み10分なら10分後の一回限定予約を作成し、保存先会話・時刻・有効状態をreadbackしてから応答を閉じる。時刻は完了保証ではなく、次の確認時刻とする。

復帰時は最初に当該予約を停止しreadbackする。その後、boardの小さい状態・durable inboxを読み、変化がある対象だけ成果を読む。予約はsession生存証拠でも完了receiptでもない。mutation前のactive identity/session/generation確認と正規awaitの二系統は維持する。

| 復帰時の状態 | 処理 |
| --- | --- |
| 終了済み | 未回収の成果だけレビューし、許可された次工程へ進める。監視対象が残らなければ再予約しない。 |
| 未終了 | 現在の進捗から次の見込みを更新し、一回限定予約を1つだけ再設定。短周期の無変化確認を避け、古い見込みのまま無限再予約しない。 |
| 人間判断待ち | 自分で回答できるworker質問は既存inbox規律で処理。人間の回答が必要なら質問を一度通知し、その回答待ちだけを理由に再予約しない。独立したworkerが走っていればそれだけの確認を予約する。 |
| 予約作成・readback失敗 | 「自動復帰設定済み」と扱わない。既存有効予約は確認なしに消さず、復帰経路の不成立を明示する。workerはdurable boardに成果を残し、オーケストレーターが自律再開できるとは約束しない。 |
| 停止readback失敗 | 同じ対象への重複予約を追加しない。保存状態を確定するまで復帰スケジュール変更を成功扱いしない。 |

トークン削減効果は、無変化の固定周期復帰を減らせること。完了が早ければ予定時刻まで回収が遅れ、見込みを超えれば再確認が必要になる。Mac停止・アプリ終了時の遅延挙動と予約更新失敗からの自動回復は未実証。
