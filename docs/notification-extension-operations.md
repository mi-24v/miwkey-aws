# 通知 extension の適用・復旧

[設計と契約](specs/notification-extension-aws-integration-design.md) に対応する運用手順。
承認済み実装のローカル検証・独立レビューと、AWS 実環境の適用確認は区別する。AWS 上の統合検証・本番演習は未実施であり、適用前の確認を §7 に残す。
固定 native-only vendor の issuer production 監査と、root CDK・開発依存の監査は分けて確認する。issuer audit 0 は、全体の安全性や AWS デプロイ承認を意味しない。
本書による publish・DNS 変更・AWS デプロイ・本番演習は行っていない。

## 1. 適用前の入力とホスト変更

- `hostprops.json` の `amiId` は必須。対象リージョンの ECS-optimized AL2023 ARM の実体、ECS / SSM agent、容量、EFS、Spot draining を確認する。AMI 更新は明示変更とする。コンテナから EC2 IMDS（`169.254.169.254`）へのアクセス遮断と、ECS task role 資格情報エンドポイント（`169.254.170.2` + `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`）の正常動作を個別に確認する。EC2 instance profile の資格情報と ECS task role の資格情報を混同しない（[AWS 公式資料](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html)）。
- ホスト変更は、[ASG とホストの制約](asg-stabilization.md) に従い、明示 AMI 入力と容量変更を含む独立したホスト用差分だけを適用する。全 HEAD をホスト更新として適用しない。extension 設定・リソースを含まないテンプレートと Change Set で範囲を確認する。
- コンテナ別・migration・extension・両 proxy・TLS のピークから予約値を決める。候補最小ホストへの適合、デプロイ中の最大台数が現行 maxCapacity 4 に収まることを確認する。AL2023 の実登録 CPU / memory は入れ替え後にも照合し、不足なら (2) に進まず予算を見直す。
- Change Set で ASG 非 replace と rolling update を確認する。入れ替え中も Misskey 2 タスクの distinct instance 配置と ALB healthy を維持する。
- 非機密の入力は FQDN、Cloudflare zone ID、固定サービス名、namespace、公開 image digest と arm64 対応、計測した budgets、ACME 連絡先、実際の alarm 購読先、renewalDays / warningDays とする。
- 公開 workflow、package 公開設定、GitHub 認証情報を使わない匿名 token / manifest 取得、digest とコードの対応を確認する。ローカルイメージ ID は公開 digest の代わりにしない。
- token は対象 zone の DNS:Edit に限定し、帯域外で専用 secret に投入する。secret・JWT・PEM・鍵・token・通知 payload はコマンド例、出力、ログ、例外本文へ出さない。
- 比較・回帰検証は `runtime-pins.json` に対応する固定 Node 24 / AL2023 / x86_64・OpenSSL 3.5.8 のイメージで行う。host の Node / OpenSSL の結果で置き換えない。native-only vendor の更新時は、上流由来・license・差分・tarball の再生成と lock integrity、実際の配布物と production 監査を照合する。

## 2. 段階適用と再入場

各段階を別の CloudFormation 更新にする。scheduled の運用開始後は、§3 の停止・排出を先に行う。
同じ更新で両サービスのタスク定義を変えない。

| stage | 適用と次へ進む確認 |
| --- | --- |
| `bootstrap` | テーブル・JWT / 証明書 / ACME / token secret、namespace、issuer・alarm、3 ログを作る。Schedule 無効、extension サービスなし。staging 有効なら予行専用 secret も作る |
| 発行（手動） | `{"mode":"bootstrap","staging":true}` で予行し、公開 DNS の伝播、所有 TXT の削除、staging 専用 trust を確認する。続けて `{"mode":"bootstrap"}` で本番アカウントと検証済み証明書を準備する。どちらも ECS デプロイなし |
| `service` | staging を false にして予行 secret を除去する。extension の 2 タスクが distinct instance で healthy、起動ログが AWSCURRENT と一致することを確認する。app / ingress の動的 hostPort と SSM 直接 CRUD を確認する |
| `client` | Misskey main に client 設定と URL / JWT secret を反映する。Misskey アプリコンテナから Service Connect / TLS / CRUD を検証する。Misskey 12.119 の client proxy 追加にもこの時点で容量が必要 |
| `scheduled` | 実際の購読先と閾値を設定し、新しい `monitoringStart` を UTC 秒精度 Z（例: `2026-10-18T00:00:00Z`）で指定する。これは Schedule StartDate にもなる。日次発行と監視を有効にする |

`/ecs/miwkey-extension/app`、`/ecs/miwkey-extension/service-connect`、`/ecs/miwkey/service-connect` は bootstrap から常設、Retain / 180 日。
この 3 ログは通常の client → service → bootstrap と再適用でも削除・再作成せず、段階的な re-entry を保つ。
ただし bootstrap 全体の除去、作成失敗、スタック削除後は Retain されたログ・テーブル・secret を先に確認し、必要な import 等を行う。同名リソースの自動取り込みや無条件の再作成は期待しない。

(3) の破壊的な切り替え前に、強制更新を 1 回（`{"mode":"scheduled","force":true}`）と有効な旧版への rollback を演習する。
その後、新 Misskey イメージの実際の NotificationService を本番 DB の移行を伴わずに隔離検証し、snapshot / dump の復元を確認して移行・import 方針を確保する。
切り替え後のテスト通知による end-to-end 確認と import の ID 突き合わせは別に行う。

## 3. 更新の停止・排出と監視再開

CloudFormation 更新、`reconcile`、証明書 rollback の前に次を行う。予約同時実行数 1 や DescribeStacks は CloudFormation とのロックにはならない。

1. テンプレート側で stage を client 等にして Schedule を止める。コンソールだけの一時変更に頼らず、手動起動も止める。
2. 停止時点から 60 秒（Scheduler）+ 60 秒（Lambda 非同期イベント）+ 900 秒（timeout）= 1020 秒を保守的に待つ。または待機イベント・実行中がゼロであることを証明する。Invocations / ConcurrentExecutions / AsyncEventsReceived / AsyncEventAge / AsyncEventsDropped、issuer ログと SSM 状態を照合し、実行中ゼロだけで排出完了にしない。
3. CloudFormation が CREATE_COMPLETE / UPDATE_COMPLETE / UPDATE_ROLLBACK_COMPLETE のいずれかであることを確認する。通常のスタック更新では extension の health と rollout 完了も確かめる。障害復旧の前提は §4・§5 に従い、復旧前の health を要求しない。
4. Schedule は停止したまま更新を完了させる。安定と health を確認後、別の後続更新で scheduled に戻す。再有効化ごとに新しい `monitoringStart` を指定し、古い日時を流用しない。

日次処理は発行と反映を分ける。unknown・容量不足・mismatch・pending があっても閾値内の証明書は発行・昇格する。
昇格後も旧 pending は残り、新版が閾値外なら翌日に再発行しない。起動ログと全タスクが一致するまで反映成功にしない。

`ApplyFailure=0` の requested / pending / deferred は成功を意味しない。反映未解決から 2 日で ApplyDelay が通知する。
旧 pending が COMPLETED でも unknown が残れば自動反映は止まり続けるため、ログ・容量・原因を調査し、必要なら §4 の手動 reconcile に進む。
circuit breaker rollback 後は failed deployment が replaced と見え、ApplyDelay 側で通知される場合がある。

MissingTelemetry は scheduled 専用で actions 常時有効。48 時間の猶予と日次 2/2 評価による約 72 時間の検出窓を見込み、warningDays は 3 より大きく、renewalDays より小さくする。
Heartbeat は scheduled 起動だけが出すため、bootstrap / reconcile は日次処理の稼働証明にならない。
CloudWatch の TIME_SERIES / EPOCH 式の作成可否、実際の alarm 発火・SNS 到達時刻は実環境で確認する。

## 4. 反映不明・失敗からの reconcile

1. §3 の停止・排出を行う。安定した CloudFormation と、`status=PRIMARY` が明示された唯一の deployment が COMPLETED または FAILED であることを確認する。status 欠落を PRIMARY とみなさず、並行更新・複数 deployment のまま実行しない。
2. `AWSCURRENT` の VersionId・証明書と、SSM `/miwkey/extension/<serviceName>/certificate-state` の JSON、現在の PRIMARY deployment ID を読み直す。SSM の `attemptedAt` / `unresolvedSince` は Unix epoch 秒、証明書 metadata の `notAfter` は UTC 秒精度 Z のまま扱う。PEM は表示・記録しない。
3. state token は `pending.intentId` を優先し、なければ `recoveryToken` を使う。pending なしでは未解決状態（`unresolvedSince`）も必要。旧 state に両 token がなければ復旧 guard を通らないため、文字列 `None` 等で代用したり SSM を手で捏造せず、固定 HEAD の状態 schema に沿って確認する。
4. Lambda を RequestResponse で 1 回呼び出す。値は直前に確認した非機密の識別子で置き換える。

```json
{
  "mode": "reconcile",
  "recovery": {
    "expectedVersionId": "CURRENT_CERTIFICATE_VERSION_ID",
    "expectedStateToken": "PENDING_INTENT_ID_OR_RECOVERY_TOKEN",
    "expectedDeploymentId": "SOLE_PRIMARY_DEPLOYMENT_ID",
    "quiescenceConfirmed": true
  }
}
```

`quiescenceConfirmed` は排出を実際に確認した場合だけ true にする。force / staging は付けない。
reconcile は証明書を発行せず、証拠がそろえば完了記録、そうでなければ現行証明書を再検証してデプロイを 1 回要求する。
期限切れなら、先に `{"mode":"bootstrap","force":true}` で検証済み新版を保存し、VersionId・SSM・PRIMARY を読み直す。

5. API 応答だけで成功とせず、唯一の deployment の明示的な `status=PRIMARY` と COMPLETED、desired 数以上の全 RUNNING タスクの startedBy・VersionId・fingerprint・notAfter が現行版と一致することを確認する。unknown・旧版・不足を成功に含めない。

要求に使った token は intent の保存で消費され、明確な API 拒否後にも再利用できない。版変更・完了でも復旧条件が失効する。
前提不一致で拒否された場合も同じイベントをループ再送せず、状態と識別子を再取得して原因を確認する。

## 5. 証明書とサービスの rollback

当面は CTO 判断の `documented_direct_ecs_rollback` を使う。既存の旧版復帰手順を具体化し、新たな rollback モードを追加しないためであり、Jev の選択確率を根拠にした決定ではない。

1. §3 のとおり Schedule・手動起動を止めて排出する。
2. 以前の版の鍵一致、SAN、公開ルート、現在も期限内であることを検証し、その版を `AWSCURRENT` に戻す。有効な版がなければ bootstrap force で検証済み新版を発行する。
3. 運用者が対象 ECS サービスへ `forceNewDeployment` を 1 回要求する。
4. 唯一 PRIMARY の COMPLETED と、desired 数以上の全 RUNNING タスクがその deployment に属し、VersionId・fingerprint・notAfter が戻した版と一致することを確認する。
5. 原因解消までは Schedule を停止維持する。確認のために scheduled モードを手動起動しない。旧版が更新閾値内なら直ちに再発行され得る。
6. 原因解消後、再開すると通常発行が再び起こり得ることを確認し、§3 の新しい monitoringStart を伴う後続更新で再開する。SSM と現在タスクの状態も再照合する。

期限切れ版・平文 HTTP には戻さない。circuit breaker は task revision を戻しても `AWSCURRENT` を戻さない。
通常更新の失敗は以前の COMPLETED revision があれば circuit breaker の対象となる。初回作成には戻り先がないため CloudFormation rollback で作成を取り消す。
(2) の取り消しでは Misskey の client 設定を外して再デプロイするが、テーブルと secret は残す。
(1) の AMI 復帰もローリングとし、保守終了済み AL2 を恒久的な戻り先にしない。
(3) の破壊的 DB 移行後は image を戻すだけでは復旧できないため、snapshot 復元手順を事前に用意する。

JWT 更新は別操作で、書き込み・読み出しを計画停止 → secret 更新 → 両サービスを片方ずつ更新 → 全タスクと認証を確認 → 再開とする。
rollback も両側を同じ旧値 / 固定 version に戻す。初回実施前に停止の実現方法と許容時間を決める。

## 6. 接続・DNS の確認

SSM 直接接続は app の networkBindings（container 名と port 8080）から動的 hostPort と EC2 を特定し、リモートホスト向け forwarding で `localhost:<app hostPort>` へ転送する。
運用者端末の hosts に一時的に `127.0.0.1 <extension-fqdn>` を追加し、必要なら NO_PROXY に含め、importer を `https://<extension-fqdn>:<localPort>` で接続する。
proxy ingress や `https://localhost` は使わず、終了後は hosts を戻す。タスク・ホスト交代時は特定し直す。
既存の `--secret` 入力には argv 露出があるため専用端末を使い、secret を履歴・画面・ログに残さない。固定 bearer token は自動更新されない。

Service Connect の確認は別に、SSM で対象ホストへ入り、タスク ARN と名前で Misskey app コンテナを特定する。
`docker exec` と既存 Node.js で、コンテナ内 env から URL / secret を読み、OS dns.lookup・proxy なし・通常 TLS 検証で alias に接続する。
テスト通知の作成 → 一覧と ID 指定取得（GSI）→ 削除 → 削除後に存在しないこと、平文の不成立、SAN 不一致の拒否を確認する。
secret・JWT・payload は引数・出力・SSM ログに出さず、ステータスと一致判定だけを出す。失敗時もテスト通知の削除を試みる。
ECS Exec は追加せず、既存の enableExecuteCommand=false を維持する。
この標準 Node.js 検証に加え、実際の NotificationService を通す隔離検証を (3) 前に行い、切り替え後にもテスト通知で確認する。

DNS では公開 resolver から期待する TXT の伝播を確認する。初期待機だけで負のキャッシュを解消済みとしない。
確実な API 拒否と作成結果不明を区別する。HTTP 4xx（408 / 429 を除く）や `success:false` は検索・再試行せず失敗とし、結果不明のときだけ固有 comment と所有 tuple で検索する。POST は繰り返さない。
強制終了・作成応答不明・cleanup 失敗時は記録した record ID・固有 comment を調べ、name / type / content / comment がすべて一致する自分の TXT だけを削除する。
一致しないものや TXT 全体を消さない。既存 TXT・他の発行者の challenge を維持する。
POST の ID は返却 tuple の検証より先に追跡する。正規の 32-byte base64url DNS-01 digest だけは、単一の引用符対で囲まれた応答も同じ値と確認してから、実際の tuple を記録する。削除直前には、その ID と name / type / content / comment の文字列が完全一致することを確認する。以後の表記変化、escape・分割文字列・不完全な応答は非機密の ID / name / comment を手掛かりに調査し、一致を確認できるまで残置させる。空・空白・欠損 ID では発行が失敗し、ID 不明（null）と name / comment を記録する。live staging で実際の content 返却形式と公開 DNS の digest を照合する。ID だけで削除したり、削除のために記録済み tuple を書き換えたりしない。TXT content・token はログに出さない。

公開 trust bundle は certifi 2026.07.22 に固定され、Root YR / YE は未収録である。更新時は追加・削除するルートと実際の CA チェーンを確認し、同梱の `public-roots.pem` と `trust.json` の版・ハッシュを同じ変更で更新する。固定イメージで署名・経路・否定側と本番 / staging の信頼分離を再検証し、完成イメージと extension / Misskey の公開 trust、発行予行を確認する。staging ルートを本番へ足して通すことはしない。

## 7. 実環境の未実施項目

以下は本書整理時点で未実施。既存 AL2 の取得済み情報・ローカルテストは、新構成の実測や本番演習の代わりにしない。
実装着手の承認ゲートを追加するものではなく、それぞれの適用・切り替え前に満たす。

| 時点 | 必須の確認・判断 |
| --- | --- |
| (1) 前 | AMI の実体、コンテナ別ピークと最小候補への適合、台数、Change Set の範囲と非 replace |
| (1) 後・(2) 前 | AL2023 の実登録容量、コンテナからの EC2 IMDS アクセス遮断、ECS task role 資格情報エンドポイントの正常動作（EC2 instance profile と分離）、EFS、SSM / forwarding / docker 権限、ECS / SSM agent、draining、ALB health |
| 本番発行前 | FQDN / zone ID、最小権限 token の投入、公開 DNS / 所有 TXT の後片付け、Cloudflare content の返却形式と不一致時の残置回収、staging 予行、実発行の公開 trust と Root YR / YE を含む bundle 更新手順 |
| issuer デプロイ前 | 固定 native-only vendor・配布物・production 監査の証拠、root 既存監査残件の扱い、実装レビューの承認対象と実環境 gate の確認。issuer audit 0 を全体の安全性に読み替えない |
| service / client 適用前後 | 公開 digest・匿名 pull・arm64、動的ポート、SSM 直接 CRUD、Misskey app からの alias / TLS / CRUD / 否定側、秘密を出さない実ログ |
| 日次処理有効化前 | 実際の SNS 購読、閾値・monitoringStart、CloudWatch TIME_SERIES / EPOCH 式の作成可否、監視再開と実通知時刻・SNS 到達 |
| (3) 前 | 強制更新・rollback 演習、新イメージの実 NotificationService の隔離検証、snapshot / dump の復元予行と復元手順、書き込み停止・差分・import 時期・ID 突き合わせ方針、通知損失リスクの受け入れ |
| (3) 後 | 2025 系の実通知による追加 end-to-end、import の ID 突き合わせ。後日 import は稼働中データの上書き条件を先に決める |
| 個別操作前 | JWT 初回更新の停止許容時間と実現方法。将来のキュー削除前の外部 consumer / 滞留 / Change Set |
