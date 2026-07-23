# ASG Stabilization Review

## 結果

Cloud確認で検出した、ASG rolling update中に1台まで減らせる問題と、ECS
deployment中に1タスクまで減らせる問題は修正済みです。マージを妨げる指摘は
ありません。修正後のChange Set確認はデプロイゲートとして残っています。

## 検証

- `mise exec -- npm test -- --runInBand`: 成功（7 tests）
- `mise exec -- npx tsc --noEmit`: 成功
- `mise exec -- npm run build`: 成功
- `mise exec -- npm run synth -- MiwkeyPublicStack --quiet --output <fresh-dir>`: 成功
- synth 結果:
  - ASG `MaxSize: 4`
  - Spot allocation strategy `capacity-optimized`
  - rolling update `MaxBatchSize: 1` / `MinInstancesInService: 2` / `PauseTime: PT5M`
  - ECS deployment `MinimumHealthyPercent: 100` / `MaximumPercent: 200`
  - ECS placement `distinctInstance` / `binpack: MEMORY`
- `git diff --check develop...feature/asg-stabilization`: 成功

## Cloud確認

- パラメータを指定した既存Change SetではRDS Secret差分が消えています。
- 実ASGは `DesiredCapacity: 2` / `MaxSize: 2` で、Healthyな2台が稼働しています。
- 実ECS serviceは `desiredCount: 2` / `runningCount: 2` / `pendingCount: 0` です。
- Launch Template移行時にARM64 ECS Optimized AL2 AMIが`20251031`版から
  `20260714`版へ更新されます。新AMIはavailableです。

## 残存リスク

- 既存の `asg-stabilization-review` Change Setは今回の2修正より前に作成されて
  います。削除して再作成し、Secret差分がなく、ASGが最低2台、ECSが最低100%
  healthyになることをデプロイ前に確認します。
- rolling update の pause はアプリケーションの正常性を保証しないため、初回
  デプロイ中は ECS running task、新規 container instance、ALB health を監視します。
- 既存の deprecated `containerInsights` とECS IMDSのwarningは今回のスコープ外です。
- `npm ci` が報告する依存関係 vulnerability は今回のスコープ外です。
