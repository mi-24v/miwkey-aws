# ASG とホスト更新の制約

- 判断日: ASG 安定化は 2026-07-22、通知 extension 用のホスト・容量方針は承認済みの [通知連携設計](specs/notification-extension-aws-integration-design.md) に従う。
- 対象: Misskey ECS on EC2 の配置、Spot 容量、Launch Template への移行と AL2023 ARM ホスト更新。
- 状態: 実装レビューは承認済み。通知連携用 AL2023 構成の AWS 実環境検証・デプロイは未実施。

## 配置と置換余力

Misskey は desiredCount 2、minHealthyPercent 100、`distinctInstances()`、memory binpack を維持する。
同じサービスの 2 タスクを別インスタンスに置き、デプロイ中も desired 数の healthy を維持するためである。
サービス間の同居・分散を保証する制約ではない。

ASG は通常 2 台と置換余力を想定して `maxCapacity: 4` とする。
Launch Template 移行は `migrateToLaunchTemplate: true` とし、rolling update は maxBatchSize 1、minInstancesInService 2、pause 5 分を維持する。
capacity rebalance、ECS Spot draining、managed draining、managed scaling、managed termination protection を維持する。
Spot の在庫や置換の成功を保証するものではなく、ローリング更新・rebalance の増分が枠内に収まるか確認する。4 台は将来の恒久上限ではない。

## 明示 AMI と通知連携用の容量

AMI は `hostprops.json` の `amiId` に明示入力し、既定値や latest への自動追従を置かない。
実体が対象リージョンの ECS-optimized AL2023 ARM であることは運用者が確認する。形式検証だけでは証明にならない。
AL2 の保守終了と Service Connect proxy の容量不足が、基盤刷新より先にホスト更新を行う理由である。

通知連携用の初期 Spot 候補は `t4g.medium`、`m6g.large`、`m7g.large`、`c6g.large`、`c7g.large` とし、100% Spot・`price-capacity-optimized` を使う。
複数プールで単一タイプの在庫不足を避けつつ、予定したホスト置換時の価格と容量を考慮するためであり、最安や空き容量は保証しない。
配分戦略だけを目的に Instance Refresh は行わない。

両 proxy、migration、TLS と両サービスの同居を含めて容量を確認する。
初期の 2 vCPU / 4 GiB とホスト用の余裕、task-level CPU / memory の予算・実測条件は通知連携設計に従う。
T4g のクレジットと unlimited 超過課金も確認し、過去の平均 Spot 価格だけで費用を決めない。

## 適用範囲と確認

ホスト更新は extension 設定・リソースを含まない独立したコミットとして扱う。
ホスト用差分に明示 AMI 入力と容量変更を含め、extension インフラ、Misskey メジャーアップグレード・DB マイグレーションとは別に適用する。
Managed Instances、Bottlerocket、WARP、awsvpc、ALB の ip target 化、大きな CDK 更新は今回の範囲に含めない。

適用前に対象環境の lookup role を使用できる認証で cloud diff と Change Set を確認する。
ASG 非 replace、rolling update、独立した変更範囲を確認し、更新中も 2 タスクの distinct instance 配置と ALB healthy を維持する。
入れ替え後の AL2023 の実登録容量・agent・EFS・SSM・draining と資格情報の分離は、[運用文書](notification-extension-operations.md) の適用前後の確認に従う。
ローカルの build・テスト・synth は、この実環境確認を代替しない。

実負荷・実登録容量が候補に収まらない場合は、タスク予算・候補一覧・初期の設定検証を再評価する。
再評価は要件の自動失効や、実環境確認を省略する許可ではない。
