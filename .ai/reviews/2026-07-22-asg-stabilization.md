# ASG Stabilization Review

## 結果

Cloud確認で検出した、ASG rolling update中に1台まで減らせる問題と、ECS
deployment中に1タスクまで減らせる問題は修正済みです。マージを妨げる指摘は
ありません。修正後のChange Set確認と本番デプロイまで完了しています。

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

- パラメータを指定したChange SetではRDS Secret差分がなく、想定したASG/ECS差分
  のみであることを確認しました。
- CloudFormation stackは `UPDATE_COMPLETE` です。
- 実ASGは `MinSize: 1` / `MaxSize: 4` / `DesiredCapacity: 2` で、
  `capacity-optimized` のMixed Instances PolicyとLaunch Templateへ移行済みです。
- 新しい2台のcontainer instanceは `InService` / `Healthy` です。
- 実ECS serviceは `desiredCount: 2` / `runningCount: 2` / `pendingCount: 0`、
  deploymentは `COMPLETED` です。
- ALB targetは新しい2台とも `healthy` です。
- 旧container instance 1台はECS managed drainingによる `Terminating:Wait` ですが、
  `DRAINING` / running tasks 0 / ALB登録なしで、サービス影響はありません。

## 残存リスク

- 旧container instanceの終了はECS managed drainingのlifecycle hook待ちです。
  hookは `HeartbeatTimeout: 3600` / `GlobalTimeout: 172800` / `DefaultResult: CONTINUE`
  であり、稼働リソースからは切り離されています。
- 既存の deprecated `containerInsights` とECS IMDSのwarningは今回のスコープ外です。
- `npm ci` が報告する依存関係 vulnerability は今回のスコープ外です。
