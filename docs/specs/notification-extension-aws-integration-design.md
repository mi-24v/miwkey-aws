# miwkey-extension AWS 連携設計

- 設計日: 2026-07-22。TLS 方式の判断: 2026-09-26〜28。文書整理: 2026-10-17。
- 対象: `miwkey-aws`、`miwkey-extension`、Misskey fork、`miwkey-notification-importer` の通知連携。
- 状態: 承認済み実装の構成・契約を記す。実装レビューの承認と本番検証の完了は別に扱う。AWS 上の統合検証は未実施。

適用・復旧・切り替え前の確認は [運用文書](../notification-extension-operations.md) に置く。
ASG とホスト更新の現行制約は [ASG・ホスト文書](../asg-stabilization.md) に置く。
本書の要件は通知連携に適用し、他サービスの方式やリポジトリ全体の制約には広げない。

## 1. 構成と採用理由

```text
Misskey（Node.js、OS dns.lookup、HTTPS + JWT）
  -> Service Connect client proxy（TCP）
  -> Service Connect server proxy（TCP）
  -> extension :8080（Go プロセスで TLS を直接終端）
  -> DynamoDB

EventBridge Scheduler（日次） -> issuer Lambda（VPC 外）
  -> Cloudflare DNS-01 / Let's Encrypt
  -> Secrets Manager（検証済み証明書）
  -> ECS のローリング再起動と起動ログによる反映確認
```

extension は Misskey と同じ ECS on EC2 クラスターの独立サービスにし、bridge network を維持する。
Misskey と extension の間は公開 CA の証明書で暗号化し、両 proxy は TCP passthrough で中継する。
サーバー認証は TLS、クライアント認証は既存の JWT とする。mTLS やサービス単位の IAM 認証は提供しない。
TCP 中継のため、HTTP ステータス別のメトリクスや HTTP 単位の再試行・ルーティングは使わない。接続レベルの挙動は実環境で確認する。

既存ホストと bridge を維持し、extension のデプロイ単位を分離するため、EC2 + Service Connect + アプリ TLS を採用する。
bridge では Service Connect managed TLS を使えないため、extension の Go プロセスで直接 TLS を終端する。
Cloudflare API で検証用 TXT を直接操作する。

既存の default SG、LB SG、NACL、VPC とピア VPC の到達性、ALB・RDS・EFS は変えない。
現行 SG では、VPC・ピア VPC・同じホストから app の動的 hostPort や proxy ingress に直接届き得る。
この経路でも app は TLS と JWT を要求する（`/healthz` は認証なし）。公開 A / AAAA、extension 用 LB、NAT は作らない。
公開 CA の Certificate Transparency ログには FQDN が載る。
Service Connect の alias は対応するタスク内で解決し、DNS-01 の公開 TXT は到達可能なエンドポイントを作らない。

## 2. 変更範囲とホスト容量

変更は (1) ホスト前提変更 → (2) extension インフラ → (3) Misskey メジャーアップグレードに分ける。
(1) は ECS-optimized AL2023 ARM と容量適合に限り、(3) のイメージ切り替え・DB マイグレーションを (2) と同じ更新に含めない。
Managed Instances、Bottlerocket、WARP、awsvpc、ALB の ip target 化、大きな CDK 更新は後続の基盤刷新で扱い、今回の通知連携には含めない。

- AMI は `hostprops.json` の `amiId` への入力を必須とする。本番の既定 AMI や自動的な latest 追従は置かず、更新は明示変更とする。ID の形式検証だけでは AL2023・ARM・ECS 対応の証明にならない。
- 初期候補は `t4g.medium`、`c6g.large`、`c7g.large`、`m6g.large`、`m7g.large`。下限 2 vCPU / 4 GiB は容量検討の前提で、将来の恒久上限や十分性の保証ではない。
- main 1024 CPU と client proxy 256 CPU の計 1280 CPU は 1 vCPU に載らない。旧 AL2 の 2 GiB ホストは予約余力が小さく、初期候補から除く。4 GiB で十分かは実測する。
- 両 proxy にそれぞれ CPU 256 以上・memory 64 MiB 以上を含める。CPU の値は本設計の予算要件で、AWS の一律強制値ではない。
- Misskey は main + migration + client proxy、extension は app + server proxy の同時予約を数える。両タスクに task-level CPU / memory を明示する。既存 L2 を維持し、必要な値は `CfnTaskDefinition` に設定して synth で確認する。
- 1 台に Misskey 1 + extension 1 が同居し得る前提で、OS・ECS agent の余裕も確保する。`distinctInstance` はサービス内の分散であり、サービス間の同居・分散を保証しない。
- TLS handshake、証明書取得・検証、migration、ローリング再起動を含むピークを測る。旧サービス全体の利用率を予約値に掛けて将来の予算を決めない。
- 実装の 2048 CPU / 3584 MiB の合計検証は、初期の 2 vCPU / 4 GiB 候補とホスト用 512 MiB の余裕に対応する。実登録容量・負荷の検証を代替せず、候補を変える際はこの検証も見直す。
- Spot は複数プールと `price-capacity-optimized` を使う。最安や空き容量を保証しない。配分戦略だけを目的に Instance Refresh は行わない。
- T4g は CPU クレジットの挙動と unlimited の超過課金も確認する。過去の Spot 平均価格だけでは見積もらない。
- ホストは maxBatchSize 1 / minInstancesInService 2 / pause 5 分の rolling update と managed draining で置換する。通常 2 台と `maxCapacity: 4` の枠で、Spot rebalance とデプロイ時の増分が収まるかを測る。4 台を将来の恒久上限にはしない。
- extension は minHealthy 100% / maxHealthy 200%。初回は extension の成功後に Misskey を更新し、以後も両サービスのタスク定義を同じ更新で同時に変えない。

AL2 の保守終了と proxy の容量不足が、後続の基盤刷新より先に (1) を行う理由である。
Spot の過去価格や旧ホストの測定値は将来の容量・費用を保証しない。TLS 用の証明書・ACME アカウント・Cloudflare token の 3 secret が常設で増え、JWT secret は別に必要となる。
一時的な staging secret、API・Lambda・イメージ保存・Scheduler・CloudWatch・SNS・ローリング増設の従量費用は別途見積もる。Private CA・内部 ALB・NAT の固定費は不要。

## 3. サービス間の契約

### 3.1 ECS とイメージ

- extension は bridge、desired 2、`distinctInstances()`、circuit breaker rollback 有効、サービス名を明示固定する。
- app のポートマッピングは `extension-tls`、containerPort 8080、protocol TCP、動的 hostPort。`appProtocol` と `ingressPortOverride` は指定しない。
- extension は client-server、Misskey は client-only。Cloud Map namespace は FQDN と独立に設定できる。alias は `clientAliases.dnsName=<extension-fqdn>` / port 8080 とし、証明書 SAN と一致させる。
- `appProtocol` の変更を in-place 更新として扱わない。サービスの作成・再作成の要否を確認する。
- 本番イメージは公開 manifest list の digest（`ghcr.io/mi-24v/miwkey-extension@sha256:...`）で固定し、linux/arm64 を含める。`sha-<commit>` タグは追跡用で、上書き不能とはみなさない。コード SHA・ローカルイメージ ID・レジストリ digest は区別する。
- ECS のヘルスチェックはタスク定義に `CMD /miwkey-extension healthcheck` を明示する。Dockerfile の `HEALTHCHECK` の継承や distroless 内の shell に頼らない。起動時の証明書処理を startPeriod に見込む。

### 3.2 データと JWT

| 設定 | 契約 |
| --- | --- |
| DynamoDB | `notifieeId` String + `sortKey` String。GSI `notificationId-index` は `id` String、projection ALL。on-demand、PITR 有効 |
| extension の env | 実テーブル名を `DYNAMODB_NOTIFICATION_TABLE`、リージョンを `AWS_REGION` に渡す。`DYNAMODB_AUTO_CREATE` は未設定 |
| JWT secret | JSON ではない SecretString を 1 つ生成。ECS secrets で extension の `AUTH_SECRET` と Misskey main の `NOTIFICATION_EXTENSION_SECRET` に注入 |
| Misskey URL | main にだけ `NOTIFICATION_EXTENSION_URL=https://<extension-fqdn>:8080`。migration には渡さない。env は YAML より優先し、URL と secret の両方で連携を有効にする |

JWT は単一キーで、新旧キーの同時受け付けや自動ローテーションは追加しない。
extension は `AUTH_SECRET` を `AUTH_SECRET_NAME` より優先する。
更新時は書き込み・読み出しを計画停止し、両サービスを更新して全タスクの切り替えと認証を確認する。
戻す場合も同じ旧値または固定 version に両側を戻す。証明書の更新とは独立した運用とする。

### 3.3 extension の TLS と起動ログ

- `TLS_MODE` 未設定は `tls`。明示的な `http` はローカル開発・既存テスト用だけとする。不正値、TLS モードでの `TLS_CERT_SECRET_ARN` / `TLS_SERVER_NAME` 欠落は起動エラーにし、HTTP にフォールバックしない。本番のタスク定義に `TLS_MODE` は設定しない。
- 証明書 secret は JSON `{"certificatePem": <fullchain>, "privateKeyPem": <key>}`。起動時に task role で `AWSCURRENT` を明示して取得し、上限時間つきで検証する。extension は PEM と秘密鍵をメモリにだけ保持し、env・ファイル・ログへ出さない。
- 鍵一致、SAN、notBefore / notAfter、公開ルートまでのチェーンを検証し、不合格なら起動しない。TLS モードでは 8080 の TLS 1.2 以上だけを待ち受け、HTTP listener・redirect を追加しない。
- 標準ルートを持つ distroless `base-debian12` を維持し、完成イメージでもルートの読み込みと公開 CA の信頼を確認する。private CA 注入は単体テストだけに限る。
- TLS 設定と listener bind 成功後にだけ、非機密の JSON ログを 1 行出す。`msg="tls certificate loaded"`、`secretVersionId`、`certFingerprintSha256`、`certNotAfter`（RFC3339）、`certSerial`、`taskArn` を固定の契約とする。
- `taskArn` は `ECS_CONTAINER_METADATA_URI_V4` の task endpoint だけから最大 2 秒で取得する。証明書取得とは独立した timeout とし、redirect や IMDS への切り替えは行わない。取得不能なら `unknown` で起動を続けるが、issuer は反映の証拠にしない。
- TLS の healthcheck は loopback に接続し、SNI に `TLS_SERVER_NAME` を使って標準ルート・名前・期限を検証する。`/healthz` は認証なしの 204 で、DB を確認しない。テーブル名や IAM の誤りは認証付き CRUD で別に検証する。
- 更新はローリング再起動で反映する。secret version をタスク定義に固定しないのは、更新ごとのタスク定義登録・権限拡大・CloudFormation との差分を避けるためである。

### 3.4 Misskey の専用 client

Service Connect alias は hosts 形式で渡される。従来の cacheable-lookup の `lookup: false` は OS への fallback を無効にするため、通知 extension だけに OS の `dns.lookup` を使う専用 agent を置く。

- 設定済み origin と固定の `/api/v1/notifications` だけに送る。proxy を経由せず、リダイレクトを追わない。JWT を他ホストへ送らない。
- 設定は http / https の origin だけを受け付け、認証情報・パス・query・fragment を含む値は警告して連携を無効にする。http はローカル互換用で、本番は https。
- 公開ルート・SAN・期限の検証と、RDS CA 用の `NODE_EXTRA_CA_CERTS` は維持する。TLS 検証の無効化は行わない。
- timeout は `timeoutMs ?? 5000`（本文読み取りも含む）、応答上限は 256 KiB。例外は `null`、一覧取得の `!ok` は空配列とする。専用 agent は shutdown 時に破棄する。
- 汎用 `HttpRequestService` の SSRF 対策、DNS キャッシュ、proxy、redirect は変えない。CDK の設定でこの client の名前解決を代替しない。

## 4. 証明書 issuer

### 4.1 DNS と発行

- Let's Encrypt の DNS-01 を使い、ユーザー管理の Cloudflare zone に `_acme-challenge.<extension-fqdn>` の TXT を直接作成・削除する。正確な FQDN・zone ID は非機密の入力で、証明書 SAN はその FQDN だけとする。
- Cloudflare token は対象 zone の `DNS:Edit` に限定する。必要な場合だけ `Zone:Read` を足し、zone 探索のための広い権限は前提にしない。token は専用 secret に帯域外で投入し、issuer が起動ごとに読み直す。無効なら `AWSCURRENT` を変えず失敗する。
- TXT は既存レコードを残して追加する。作成意図に固有の comment を付け、POST 応答の record ID を返却 tuple の検証より先に追跡し、期待する tuple（name / type / content / comment）を保持する。空・空白・欠損 ID は発行失敗とし、ID 不明・name・comment の非機密な証拠を残す。POST は 1 回だけとし、結果不明のときだけ固有 comment と所有 tuple で検索する。HTTP 4xx（408 / 429 を除く）または JSON の `success:false` は確実な拒否として、検索・再試行せず失敗する。408 / 429 / 5xx、通信・timeout・応答解析の失敗は結果不明として扱う。
- Cloudflare の TXT 自動引用符に対応するため、作成応答・結果不明後の検索では、正規の 32-byte base64url DNS-01 digest と、それを単一の二重引用符で囲んだ表記だけを同じ値として照合する。name / type / comment の完全一致も必要とし、照合後の実際の tuple と ID を記録する。escape・分割文字列・余分な空白は解釈しない。削除直前には記録した ID と tuple の文字列の完全一致を要求する。表記の変化や不一致は正規化して削除せず、残置と非機密の証拠を運用へ引き継ぐ。
- 公開 DNS で伝播を上限つきで確認する。Cloudflare API の成功や初期待機だけでは負のキャッシュが解消したとはみなさない。キャンセル時も所有情報を確保して後片付けし、強制終了による残置は運用で確認する。
- ACME アカウント鍵と URL は専用 secret に保存する。JSON の `directory`、`key`（秘密 RSA JWK）、`account_url` の schema を維持する。gufo 0.7.0 が保存した `kty` なしの鍵は、RSA 秘密鍵の全フィールド（`n,e,d,p,q,dp,dq,qi`）がそろう場合だけ RSA として復元する。固定 OpenSSL の鍵整合性検査を client 作成前に行い、RSA / CRT 成分の内部不整合を拒否する。インポートや署名・検証の成功だけでは整合性の証明にしない。不完全な鍵・別形式の鍵を補完せず、本番・staging の directory とアカウント URL の一致も検証する。登録・URL・secret は環境ごとに分け、定期実行で未初期化なら自動で作り直さない。
- staging の証明書は予行専用 secret にだけ保存する。予行では staging ルートだけ、本番では公開ルートだけを使って検証する。信頼の混在・skip verify は認めない。
- 候補は書き込み前に鍵・SAN・有効期間・チェーンを検証する。初回 Put は自動で `AWSCURRENT` になるため、初回も例外にしない。更新時は `AWSPENDING` に保存・読み戻し・再検証し、合格した版だけ昇格する。昇格前の失敗では旧 `AWSCURRENT` を維持する。
- 証明書 payload は標準 `CERTIFICATE` の PEM ブロックだけとし、混在する非標準ラベルや DER 末尾の余分なデータを拒否する。証明書の外側の構造・Name・primitive 値・DEFAULT には DER の規則を適用し、既知の AlgorithmIdentifier、OID のデコード上限、型付き整数や SPKI のビット表現も固定した cryptography 50.0.2 に合わせて検査する。PBES2 / PBKDF2 / scrypt / PBE などの型付きパラメーターも、フィールド順序・整数上限・DEFAULT・IV 長まで検査する。これは署名方式や発行者鍵の許可範囲を広げるものではない。未知の拡張値の OCTET STRING の内容を ASN.1 と仮定しない。metadata は検証した同じ leaf から算出する。
- 拡張は構文だけでなく、KU のフラグ間条件、AKI の issuer / serial の組、PKUP の期間、IP 表現などの意味条件と、既定の拡張 policy も検査する。leaf は公開拡張オブジェクトを作る範囲で、directoryName と relativeName の空 RDN・重複属性・属性値の型や文字列符号化も検査する。leaf の EKU がある場合は serverAuth を必須とする。CA は AIA / AKI / KU / BC / EKU / NC の既定 policy を対象とし、leaf と同じオブジェクト化の条件を一律に課さない。探索中の型付き解析では、CA の Name 属性や otherName の不透明な値を比較 oracle と同じ範囲で不透明なまま扱う。CA AKI の authorityCertSerialNumber は、この解析段階では符号付き ASN.1 整数として扱い、証明書自身の非負 serial 条件とは区別する。これとは別に、NameChain が読む自己発行でない CA の SAN も、候補になる順序と段階に合わせて解析する。比較 oracle の受理判定で評価した critical な directoryName 制約は探索全体の失敗とし、未対応の名前制約と同じ種類の SAN が評価される場合は、その経路の失敗として扱う。DNS / RFC822 / IP の制約は同じ種類の SAN との組ごとに妥当性と一致を判定する。permitted は一致した時点で打ち切り、未評価の不正値や異なる種類の組を一律に拒否しない。候補になる前の証明書や自己発行 CA の SAN を一律に深く検査しない。
- 自己発行判定と issuer / subject の同一性は、表示文字列ではなく ASN.1 Name の符号化を比較する。leaf の subject が空かどうかは ASN.1 Name の RDN 列で判定し、空の RDN があるだけの Name を空 subject とみなさない。subject が空でない場合だけ critical SAN を拒否し、真に空の subject の critical SAN は他の検証条件も満たす場合に受理する。CN を省略する Let's Encrypt profile への変更時にも、この境界を維持する。
- TypeScript issuer は全ビット 0 の Key Usage（KU）、notAfter 到達時点（等値を含む）、`TRUSTED CERTIFICATE` を混在させた payload を拒否する。PEM 本文内の空白・NBSP・U+2028、空 RDN だけの subject に非 critical SAN を組み合わせた証明書、critical な leaf SKI、x400Address を含む CA SAN も拒否する。OpenSSL が拒否する AKI / SKI の欠落・不一致、CA の anyEKU だけの EKU、非 critical な directoryName 制約による subject DN の制限も維持する。AKI が空の場合や、CA AKI の serial が負の場合・issuer を伴わない場合も、完成した経路への追加検査または native 検証で拒否する。CA SAN の directoryName に INTEGER 型の属性値がある場合も native 検証で拒否する。CA AIA の otherName（比較した BOOLEAN / UTF8String の値）を型付きライブラリが拒否する差と、CA SAN の otherName の内側が非 DER の場合に拒否する差も、完成した候補経路の判定で維持する。外側にある Name の Any 値や未知アルゴリズムの構成値への再帰的な DER 検査も維持する。内外が一致する未知の署名 AlgorithmIdentifier を持つアンカーも、固定 native 検証により拒否される場合がある。これらは旧 Python 比較 oracle より厳しい差である。KU 拡張の欠落とは区別し、self-issued intermediate も数える保守的な pathLen 制約を維持する。担当者は、弱い受理を修正する要件と固定 oracle の解析・探索・policy に合わせるため、この境界を採用した。Jev の選択結果は助言として扱い、担当者の採用理由や実装承認とは区別する。有限の比較検証に基づくもので、全入力で旧実装と同等とは主張しない。

### 4.2 発行と反映の分離

issuer は VPC 外のコンテナ Lambda とし、日次 Scheduler、予約同時実行数 1、timeout 900 秒で動く。
今回の issuer は Node 24 / AL2023 / x86_64（linux/amd64）の TypeScript 実装とする。ルートの CDK の位置を維持し、issuer を private npm workspace に置く。
ランタイムは `runtime-pins.json`、証明書検証用 OpenSSL 3.5.8 とその実行ファイル・ライブラリのハッシュで固定する。本番の公開ルートは certifi 2026.07.22 の同梱 PEM と `trust.json`、staging は別の同梱 `staging-roots.pem` で内容を固定し、OS の暗黙の信頼先に広げない。
固定 AL2023 OpenSSL 3.5.8 は `auth_level 2` で SHA-1 署名を受理する。level 3 では拒否するが、許可対象の RSA-2048 CA 鍵まで弱い鍵として拒否するため、level の変更だけでは検証方針を満たさない。選択した経路ごとに、アンカーを含む全証明書の v3・内外の署名方式一致・非負 serial（0 を含む 1〜21 octet）・issuer・時刻の符号化を cryptography 50.0.2 の基本方針に合わせて確認する。1950〜2049 年は UTCTime、それ以外は GeneralizedTime とし、秒と Z を持つ形式だけを受け付ける。さらにアンカーの自己署名を除く各証明書の AlgorithmIdentifier と、発行者（アンカーを含む）の SPKI・RSA サイズ条件を確認し、その後 OpenSSL の strict な TLS サーバー用途の全経路検証を行う。RSA 発行鍵の 2040-bit 境界は TypeScript が oracle より厳しく拒否する。中間 CA は最大 8 段とし、固定した比較 oracle の実装に合わせて自己発行の中間 CA も数える。同名の候補は AKI / SKI の一致、片方の欠落、不一致の順に安定ソートし、同じ順位では信頼アンカーを先に試す。候補の鍵が復号できなくても、その候補だけを除外して別の有効な経路を探す。拡張 OID の同一性は、丸めを含む表示文字列ではなく正規 DER の値で判定する。型付きの拡張オブジェクトも元の DER から生成し、OID の再シリアライズによって未知の拡張を SAN や BasicConstraints として解釈しない。候補の拡張 OID の重複は、その階層の探索を打ち切り、呼び出し元へ候補解析失敗として返す。SAN の解析エラーが比較 oracle で探索を打ち切る境界と、正常な経路を採用した後の未評価候補は区別する。
候補ごとの追加の厳格検査が比較 oracle の打ち切りを隠したり、成功後の未評価候補で拒否を増やしたりしないよう、まず oracle 相当の順序で受理可否を判定し、最初の成功経路で探索を止める。その経路に既存の厳格検査と固定 OpenSSL の全経路検証を適用する。不合格なら、同じ CA・署名・名前制約の条件を課した、作業量に上限のある別経路の探索を行う。oracle が成功した後に、その探索で見つかる解析エラーや Fatal は候補の不採用として扱い、既に確定した受理可否を取り消さない。返す経路への厳格検査や OpenSSL 検証は省略しない。
この受理判定では、名前制約の組を全分岐で合計して最大 1,048,576 回、署名検査を最大 128 回とし、超過は探索全体の失敗とする。名前制約は異なる種類の組も数え、permitted が一致して以後を評価しない場合は数えない。署名予算は CA policy と公開鍵の読み込みに合格した後、署名の検証前に課金する。自己発行に限らず、同じ候補を再び試す場合（相互発行の循環を含む）も、実際の署名検査と名前制約の試行を各予算に数える。受理判定では循環として省略しない。中間 CA の最大 8 段は維持し、後段の厳格な別経路探索では循環除外を行う。固定した cryptography 50.0.2 の実装に合わせた上限であり、証明書ごとの OpenSSL の上限だけでは代替しない。
署名は RSA PKCS#1 v1.5 / PSS と ECDSA の SHA-256/384/512、および ML-DSA 44/65/87 を許可する。PSS は hash・MGF・salt も厳密に照合する。SHA-1・EdDSA の署名や EdDSA 発行者は拒否する。Ed25519 / Ed448 の leaf 公開鍵は他の検証条件を満たせば受理する。単純な RSA / ECDSA だけの許可リストにはしない。
証明書とアカウントの秘密鍵は、固定 OpenSSL の `pkey -check` の標準入力へメモリから渡して内部整合性を検査し、ファイル・argv・ログには出さない。証明書の公開鍵との一致は Node 内で照合し、秘密鍵は OpenSSL の証明書経路検証へ渡さない。出力を捕捉し、timeout と固定した環境で検査する。Python 比較 oracle・開発用資産・開発依存は配布アプリ（`/var/task`）に含めず、Python 処理系も追加しない。Node ベースイメージ内の npm 付属補助ファイルとは区別する。extension 本体の Go / ARM 構成は変えない。
ACME は 5.4.0 から未使用の Forge 実装・API・型・依存を除いた、固定 native-only vendor を使う。暗号処理の改変や旧版への downgrade はせず、Node ネイティブの経路を維持する。上流由来・MIT license・ソース差分・再生成 tarball と lock の integrity を記録する。
Scheduler と Lambda 非同期呼び出しの再試行は両方 0、最大イベント経過時間はそれぞれ 60 秒。
bootstrap はアカウント初期化と証明書保存だけを行い、`UpdateService` を呼ばない。CloudFormation custom resource からの同期 bootstrap は行わない。
発行処理の authorization / order のポーリングと待機は、共有する合計 600 秒の期限内で行い、期限後に次の CA 操作を始めない。ポーリング待機は中断可能とし、HTTP 障害の再試行はしない。アプリからの非冪等な CA 操作は 1 回だけ呼び出す。明示的な `badNonce` 拒否後のライブラリによる再署名は最大 5 回で、旧 gufo 0.7.0 の 1 回とは異なる。これは、結果不明や HTTP 障害による再試行とは区別する。DNS の処理・後片付けは別途上限つきで終了を待つため、期限経過と同時に全処理が終わる保証ではない。呼び出しの `force` / `staging` は省略時だけ false とし、明示的な null や boolean 以外の値は拒否する。

日次の発行・昇格はデプロイ可否から分離する。unknown task、容量不足、旧版との mismatch、未解決 pending があっても、更新閾値内なら発行する。
更新閾値は実際の notAfter を基準にし、既定は残り 30 日。証明書の固定の有効期間は仮定しない。
新しい `AWSCURRENT` が閾値外なら、翌日は反映だけを確認し、同じ理由で再発行しない。観測・認証・保存 API 自体の失敗時の回復は別に扱う。

反映は対象サービスへの `forceNewDeployment` だけとし、タスク定義は変更しない。
安定した CloudFormation と唯一の完了済み PRIMARY を確認して進める。確認はロックではないため、競合は運用文書の停止・排出手順で防ぐ。

成功には、安定したスタック、`status=PRIMARY` が明示された唯一の deployment の rollout `COMPLETED`、desired 数以上の全 RUNNING タスクがその deployment に属し、
起動ログの VersionId・fingerprint・notAfter が現在の `AWSCURRENT` と一致することをすべて要求する。
API 応答、secret の昇格、旧版のログ、unknown や不足タスクを成功の代わりにしない。Lambda 内で rollout を待ち切らず、後続の起動で確認する。

反映状態は CloudFormation 管理外の非機密 SSM String パラメーターに保存する。
current / deployed、pending の version・deploymentId・intentId・metadata、要求前の deployment 一覧、試行時刻・回数、未解決の開始時刻・結果・recoveryToken を持つ。
`attemptedAt` / `unresolvedSince` は Unix epoch 秒、証明書 metadata の `notAfter` は UTC 秒精度 Z を維持し、ミリ秒へ変換しない。成功確認と `reconcile` は deployment の `status` 欠落を PRIMARY とみなさない。
非冪等なデプロイ要求より先に intent を保存し、応答不明時に自動で重複要求しない。
昇格しても旧 pending を上書きせず、現在版の全タスクによる証明か、停止・排出確認を伴う `reconcile` だけで解消する。
旧 pending が `COMPLETED` でも unknown が残れば、新版への昇格後も自動デプロイは停止する。

### 4.3 監視と復旧の方針

- 実配信の期限は RUNNING タスクごとの起動ログの最小 notAfter で監視する。`AWSCURRENT` の期限だけでは、旧証明書のまま動くタスクを検出できない。ログ欠落は unknown とし、正常扱いしない。
- 発行・token・アカウント・検証・保存・観測・デプロイ要求の失敗、unknown、反映失敗、反映遅延、Lambda エラー、定期実行の欠落を監視する。
- `ApplyFailure` は requested / pending / deferred では 0。FAILED または明確な拒否では 1 とする（不正な復旧要求も失敗として扱う）。`ApplyDelay` は試行回数でなく未解決からの経過 2 日で通知する。
- circuit breaker の巻き戻し後に対象の失敗 deployment が一覧から消えると、`failed` ではなく `replaced` と見え、ApplyDelay 側で通知される制約がある。
- `MissingTelemetry` は scheduled 段階だけに作り、actions は常時有効にする。再有効化ごとに新しい UTC 秒精度 Z の `monitoringStart` を指定し、Schedule StartDate にも使う。48 時間猶予 + 日次 2/2 評価で約 72 時間の検出窓を見込むため、`warningDays > 3` かつ `warningDays < renewalDays` を必須とする。
- alarm の通知先は既存の `MiwkeyPublicTopic` を同じ construct ID・論理 ID のまま使う。新 topic は作らず、購読先は実際の運用者の入力とする。未使用の `SqsSubscription` を外し、`MiwkeyPublicQueue` 自体は残す。外部 consumer・滞留・Change Set の確認前にキューを削除しない。
- 証明書 rollback は当面 `documented_direct_ecs_rollback` とする。既存の「旧版に戻して ECS を再デプロイ」を具体化し、専用の新モードを増やさないという CTO の運用判断による。有効な検証済み旧版を先に `AWSCURRENT` に戻す。期限切れ版・HTTP へは戻さない。
- circuit breaker は証明書 version を戻さない。証明書 rollback 中は日次処理を止め、原因を解消するまで維持する。状態不明の反映を再要求する `reconcile` と rollback は別の操作とする。

## 5. 権限・保持・ログ

| 主体 | 権限の範囲 |
| --- | --- |
| extension task role | 対象テーブルと `notificationId-index` のデータ操作、証明書 secret の読み取り。CreateTable / UpdateTable は与えない |
| extension execution role | JWT secret 注入、イメージ取得、ログ。証明書の読み取りは task role に分ける |
| Misskey | JWT secret 注入のみ。証明書・ACME アカウント・Cloudflare token の secret へはアクセスさせない |
| issuer | 証明書・ACME・予行 secret の読み書きと version 操作、Cloudflare token の読み取りだけ。対象サービスの Describe / Update、クラスター内のタスク列挙・確認、対象スタックの Describe、状態 SSM の読み書き |
| issuer の観測・通知 | app ログだけの読み取り、自身のログだけの書き込み、`Miwkey/ExtensionCertificate` だけの PutMetricData。SNS Publish は与えず、topic policy で同一アカウントの CloudWatch alarm に許可 |
| 運用者 | 対象インスタンス・ドキュメントを限定した SSM セッション、必要な secret の読み取り、ホストの docker 操作を個別に許可 |

issuer のサービス ARN は固定サービス名・クラスター・リージョン・アカウントから構成し、サービスへの Ref で循環依存を作らない。
Route 53 権限は不要。Cloudflare 側の認可は token で制限し、AWS IAM が制限できるのは secret の読み取りまでとする。

テーブル、JWT・証明書・ACME・Cloudflare token の各 secret は `RETAIN`。PITR はテーブルに設定する。
証明書と token は初期値なしで作り、SecretString / GenerateSecretString をテンプレートに置かない。
予行の証明書・アカウント secret は `RETAIN` にせず、bootstrap 後の段階で除去する。

以下の 3 ロググループは bootstrap から全段階で所有し、`RETAIN`、保持 180 日とする。

- `/ecs/miwkey-extension/app`
- `/ecs/miwkey-extension/service-connect`
- `/ecs/miwkey/service-connect`

issuer のログも保持 180 日。proxy access log は無効にする。
payload、JWT、Authorization、secret の値・JSON 全体、秘密鍵、ACME アカウント鍵、Cloudflare token はログ・例外本文に出さない。
記録するのは非機密の状態・証明書 metadata・失敗段階・固定の安全なエラー型ラベルとする。任意の name・message・stack・応答本文は記録せず、未知の型は `Error` にまとめる。状態ログの証拠フィールドが未設定ならキーを省略せず null を出す。query の `userId` 除去は別の任意改善として残す。
非機密の設定だけを loader で検証して stack に渡し、secret の値を context・props・平文 env・Output に置かない。
Outputs はクラスター・サービス・namespace・テーブル、secret ARN、FQDN・zone ID、issuer ARN・既存 topic ARN に限る。
保持したリソースは、スタック削除・再作成で自動再取り込みされない。

## 6. 障害・import と確認要件

Misskey の通知 POST は投げたままで HTTP ステータスを確認せず、送信例外は `null` となる。
一覧は先に Redis を使い、0 件なら extension に問い合わせ、`!ok` なら空配列を返す。
そのため永続化は表に出ないまま失われ得て、古い通知のページが空に見えることもある。
TLS・名前解決の失敗も同じ扱いで、永続的な再試行や通知保証は今回追加しない。損失を受け入れるかは (3) の前に運用要件から判断する。

importer は既存コードのまま、運用者端末から SSM port forwarding で app の TLS に直接接続する。
単独 ECS タスクの Service Connect 利用や LB は前提にしない。FQDN を SNI / SAN と一致させ、公開ルートと JWT を通常どおり検証する。
`--secret` で短命 JWT を生成し、固定の `--bearer-token` が長時間の import 中に失効する事態を避ける。
既存 CLI の argv 露出は専用端末で受け入れ、ヒストリー・ログには記録しない。入力経路の改善は別変更とする。

import は createdAt / id 順で、最初のエラーで停止し、手動の `--resume-after-id` で再開する。
同じキーへの再送は条件なし Put により上書きとなり、重複しなくても更新済み `isRead` を戻し得る。
破壊的 DB 移行前に snapshot / dump の復元を確認し、書き込み停止・差分・突き合わせ方針を確保する。import 元は dump を復元した一時 PostgreSQL とする。

受け入れでは build・テスト・synth に加え、上記のネットワーク、CPU / memory、env・secret、IAM、保持、依存順序、alarm・通知、段階設定、非機密 Outputs を assert する。
TLS の否定側（鍵・SAN・信頼・期限・平文拒否）、metadata timeout・bind 前の成功ログ禁止、DNS 所有権、staging 分離、発行と反映の独立性、冪等性、復旧 token の再利用拒否、ログ秘匿を検証する。
Misskey の origin 制限・OS 名前解決・proxy / redirect 禁止・timeout / size・shutdown と汎用 client 不変も検証対象とする。

実環境では SSM の直接 CRUD、Misskey コンテナからの Service Connect / TLS / CRUD、新 Misskey イメージの実際の NotificationService の隔離検証を別々に行う。隔離検証では本番 DB を移行しない。
標準 Node.js の経路確認だけで実アプリの検証を代替しない。(3) 前の強制証明書更新と rollback 演習、(3) 後の追加 end-to-end 確認も必須とする。
具体的な段階と未実施項目は運用文書に集約する。

## 7. 再評価条件と根拠

- Managed Instances / awsvpc への移行時は、Service Connect managed TLS、タスク SG、ホスト ingress、容量、SSM 経路を再評価する。
- 実負荷・実登録容量が候補に収まらなければ、タスク予算・インスタンス一覧・初期の設定検証を見直し、必要なら Fargate 案を検討する。
- CT による FQDN 公開が許容できなくなった場合、CA の更新方針が変わった場合は TLS・更新閾値を再評価する。
- 損失要件、停止許容時間、単一キーの運用が合わなくなった場合は再試行・キー更新を別の設計変更として扱う。再評価条件は要件の自動失効や変更許可ではない。

Jev の評価は個別の問いに対する参考情報であり、設計全体の承認や実測の代わりにしない。容量・移行順序・計画停止・通知損失の受け入れは、運用文書の各段階で確認・判断する。
候補依存の確率を妥当性の独立証明とせず、設計判断を変更する場合は `typesafe-ai` skill に従って再照会する。

主な一次資料:

- [Service Connect の構成と bridge](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts-deploy.html)、[managed TLS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-tls.html)
- [ClientAlias](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ServiceConnectClientAlias.html)、[PortMapping](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_PortMapping.html)、[CDK ServiceConnectService](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.ServiceConnectService.html)
- [managed scaling の容量条件](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/managed-scaling-behavior.html)、[ECS-optimized AMI](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html)、[ECS healthcheck](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html)
- [Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)、[Cloudflare DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)、[token の権限範囲](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [cacheable-lookup 7 の実装](https://raw.githubusercontent.com/szmarczak/cacheable-lookup/v7.0.0/source/index.js)、[ECS agent の hosts 設定](https://pkg.go.dev/github.com/aws/amazon-ecs-agent/agent@v0.0.0-20260421173302-3def019fc9fa/engine/serviceconnect)
- [CDK v2.217.0 Ec2TaskDefinition](https://github.com/aws/aws-cdk/blob/v2.217.0/packages/aws-cdk-lib/aws-ecs/lib/ec2/ec2-task-definition.ts)、[Cfn 出力の基底定義](https://github.com/aws/aws-cdk/blob/v2.217.0/packages/aws-cdk-lib/aws-ecs/lib/base/task-definition.ts)
- [App Mesh からの移行](https://aws.amazon.com/blogs/containers/migrating-from-aws-app-mesh-to-amazon-ecs-service-connect/)
