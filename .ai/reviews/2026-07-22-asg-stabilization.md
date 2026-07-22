# ASG Stabilization Review

## 結果

マージを妨げる指摘はありません。ECS の `desiredCount: 2` と
`distinctInstance` に対し、ASG の `maxCapacity: 4`、Spot インスタンスの
多様化、Launch Template 移行時の rolling update が整合しています。

## 検証

- `mise exec -- npm test -- --runInBand`: 成功（6 tests）
- `mise exec -- npx tsc --noEmit`: 成功
- `mise exec -- npm run build`: 成功
- `mise exec -- npm run synth -- MiwkeyPublicStack --quiet --output <fresh-dir>`: 成功
- synth 結果:
  - ASG `MaxSize: 4`
  - Spot allocation strategy `capacity-optimized`
  - rolling update `MaxBatchSize: 1` / `MinInstancesInService: 1` / `PauseTime: PT5M`
  - ECS placement `distinctInstance` / `binpack: MEMORY`
- `git diff --check develop...feature/asg-stabilization`: 成功

## 残存リスク

- `agent-readonly` profile は CDK lookup role を assume できないため、実環境の
  `cdk diff` は未実施です。デプロイ前に lookup 可能な承認済み profile で
  cloud diff を確認する必要があります。
- rolling update の pause はアプリケーションの正常性を保証しないため、初回
  デプロイ中は ECS running task、新規 container instance、ALB health を監視します。
- 既存の deprecated `containerInsights`、ECS IMDS、既定
  `minHealthyPercent` の warning は今回のスコープ外です。
- `npm ci` が報告する依存関係 vulnerability は今回のスコープ外です。
