# ASG Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a minimal deployable branch where two Misskey ECS tasks can run on distinct EC2 instances backed by diversified Spot capacity and an ASG with enough replacement headroom.

**Architecture:** Reuse the reviewed placement and Mixed Instances Policy commits without bringing in the full refactor. Repair the existing CDK test fixture, add synthesized-template regression assertions, then raise the ASG maximum capacity from the CDK default of one to four.

**Tech Stack:** TypeScript 4.9, AWS CDK v2 (`aws-cdk-lib` 2.217.0), Jest 29 with `ts-jest`, Node.js via mise

## Global Constraints

- Start from `feature/asg-stabilization`, which branches from `develop` at `ed525fc`.
- Preserve `feature/full-refactor` at `155db42`; do not merge, rebase, or reset it.
- Reuse only `67024a6` and `e9f190e` from the ASG work before adding the test repair and capacity fix.
- Keep `desiredCount: 2`, `PlacementConstraint.distinctInstances()`, and `PlacementStrategy.packedByMemory()`.
- Set ASG `maxCapacity` to exactly `4`.
- Keep the six Graviton Spot types: `t4g.small`, `t4g.medium`, `m6g.medium`, `m7g.medium`, `c6g.medium`, and `c7g.medium`.
- Keep Spot allocation strategy `capacity-optimized` and 100% Spot capacity.
- Run Node.js, npm, and CDK commands through `mise exec --`.
- Do not stage or commit the existing untracked `.ai/` and `.claude/` directories.
- Commit tracked transpiled `.js` outputs produced by the final successful build; do not add a generated-file cleanup to this branch.

---

### Task 1: Restore the reviewed placement and Spot diversification commits

**Files:**
- Modify: `lib/miwkey-public-stack.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `MiwkeyPublicStack.miwkeyMainCluster()` and the existing ECS EC2 capacity provider.
- Produces: A distinct-instance ECS placement constraint and an ASG Mixed Instances Policy with six ARM instance types.

- [ ] **Step 1: Confirm the branch base and protected refactor tip**

Run:

```bash
git branch --show-current
git merge-base feature/asg-stabilization develop
git rev-parse develop
git rev-parse feature/full-refactor
```

Expected:

```text
feature/asg-stabilization
ed525fc...
ed525fc...
155db42...
```

- [ ] **Step 2: Restore the placement commit**

Run:

```bash
git cherry-pick 67024a6c60ecb8a8dab41485e786e3434c569d36
```

Expected: a new commit named `feat: binpack戦略かつdistinct制約に変更` that imports `PlacementConstraint`, uses `distinctInstances()`, and replaces instance spreading with memory bin-packing.

- [ ] **Step 3: Restore the Mixed Instances Policy commit**

Run:

```bash
git cherry-pick e9f190e1fdfd7099fe6db51b2cea0c38a0862502
```

Expected: a new commit named `feat: SpotプールをMixedInstancesPolicyで多様化` that adds the launch template, SSM instance role, Spot draining user data, six launch template overrides, and `capacity-optimized` allocation.

- [ ] **Step 4: Verify the restored source tree**

Run:

```bash
git diff --check
git diff --exit-code e9f190e1fdfd7099fe6db51b2cea0c38a0862502 HEAD -- lib/miwkey-public-stack.ts package-lock.json
git status --short
```

Expected: both diff commands exit zero. Status lists only the pre-existing untracked `.ai/` and `.claude/` directories.

### Task 2: Repair the CDK stack test fixture

**Files:**
- Modify: `test/miwkey-public.test.ts`

**Interfaces:**
- Consumes: `MiwkeyPublicStackProps` requiring a VPC, subnets, two security groups, and a certificate.
- Produces: `createTemplate(): Template`, a reusable synthesized-template fixture for all stack assertions.

- [ ] **Step 1: Replace the invalid two-argument stack construction**

Replace `test/miwkey-public.test.ts` with:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { SecurityGroup, Subnet, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import * as MiwkeyPublic from '../lib/miwkey-public-stack';

function createTemplate(): Template {
  const app = new cdk.App();
  const supportStack = new cdk.Stack(app, 'TestSupportStack');
  const vpc = new Vpc(supportStack, 'TestVpc', {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [{ name: 'test-public', subnetType: SubnetType.PUBLIC }]
  });
  const stack = new MiwkeyPublic.MiwkeyPublicStack(app, 'MyTestStack', {
    mainVpc: vpc,
    mainSubnets: vpc.publicSubnets.map(subnet => subnet as Subnet),
    defaultSG: new SecurityGroup(supportStack, 'TestDefaultSG', { vpc }),
    loadBalancerSG: new SecurityGroup(supportStack, 'TestLoadBalancerSG', { vpc }),
    domainCertificate: Certificate.fromCertificateArn(
      supportStack,
      'TestCert',
      'arn:aws:acm:ap-northeast-1:123456789012:certificate/00000000-0000-0000-0000-000000000000'
    )
  });

  return Template.fromStack(stack);
}

test('SQS Queue and SNS Topic Created', () => {
  const template = createTemplate();

  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 300
  });
  template.resourceCountIs('AWS::SNS::Topic', 1);
});
```

The `Match` import is intentionally introduced here because Task 3 uses it for partial array assertions.

- [ ] **Step 2: Verify the fixture compiles and the existing test passes**

Run:

```bash
mise exec -- npx tsc --noEmit
mise exec -- npm test -- --runInBand
```

Expected: TypeScript exits zero and Jest reports `1 passed, 1 total`.

- [ ] **Step 3: Commit the fixture repair**

Run:

```bash
git add test/miwkey-public.test.ts
git commit -m "test(stack): repair public stack fixture"
```

Expected: one test-only commit; `.ai/` and `.claude/` remain untracked.

### Task 3: Add ASG regression coverage and capacity headroom

**Files:**
- Modify: `test/miwkey-public.test.ts`
- Modify: `lib/miwkey-public-stack.ts`
- Modify after build: `test/miwkey-public.test.js`
- Modify after build: `lib/miwkey-public-stack.js`

**Interfaces:**
- Consumes: `createTemplate(): Template` from Task 2 and CDK `Match.arrayWith()` / `Match.objectLike()` assertions.
- Produces: `AWS::AutoScaling::AutoScalingGroup.MaxSize = "4"` while preserving ECS desired count, placement, and Spot pool properties.

- [ ] **Step 1: Add synthesized-template regression tests**

Append these tests to `test/miwkey-public.test.ts`:

```typescript
test('ASG has capacity for redundant tasks and replacement headroom', () => {
  const template = createTemplate();

  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MaxSize: '4'
  });
});

test('ASG uses diversified capacity-optimized Spot pools', () => {
  const template = createTemplate();

  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MixedInstancesPolicy: Match.objectLike({
      InstancesDistribution: Match.objectLike({
        OnDemandBaseCapacity: 0,
        OnDemandPercentageAboveBaseCapacity: 0,
        SpotAllocationStrategy: 'capacity-optimized'
      }),
      LaunchTemplate: Match.objectLike({
        Overrides: Match.arrayWith([
          { InstanceType: 't4g.small' },
          { InstanceType: 't4g.medium' },
          { InstanceType: 'm6g.medium' },
          { InstanceType: 'm7g.medium' },
          { InstanceType: 'c6g.medium' },
          { InstanceType: 'c7g.medium' }
        ])
      })
    })
  });
});

test('ECS keeps two tasks on distinct container instances', () => {
  const template = createTemplate();

  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 2,
    PlacementConstraints: Match.arrayWith([
      { Type: 'distinctInstance' }
    ]),
    PlacementStrategies: Match.arrayWith([
      { Field: 'MEMORY', Type: 'binpack' }
    ])
  });
});
```

- [ ] **Step 2: Run the tests and confirm the capacity regression fails**

Run:

```bash
mise exec -- npm test -- --runInBand
```

Expected: three tests pass and `ASG has capacity for redundant tasks and replacement headroom` fails because the synthesized `MaxSize` is `"1"`, not `"4"`.

- [ ] **Step 3: Set the ASG maximum capacity**

In the `new AutoScalingGroup(this, "miwkeyASG", ...)` properties, add `maxCapacity` immediately after `capacityRebalance`:

```typescript
capacityRebalance: true,
// Two steady-state instances plus room for rolling replacement and Spot rebalance.
maxCapacity: 4,
vpcSubnets: subnetSelection,
```

- [ ] **Step 4: Verify tests, type checking, build output, and synthesis**

Run:

```bash
mise exec -- npm test -- --runInBand
mise exec -- npx tsc --noEmit
mise exec -- npm run build
mise exec -- npm run synth -- --quiet
git diff --check
```

Expected: Jest reports `4 passed, 4 total`; TypeScript, build, synth, and diff checks all exit zero. The build updates the tracked JavaScript files to match their TypeScript sources.

- [ ] **Step 5: Review and commit the capacity fix with its regression tests**

Run:

```bash
git status --short
git diff -- lib/miwkey-public-stack.ts lib/miwkey-public-stack.js test/miwkey-public.test.ts test/miwkey-public.test.js
git add lib/miwkey-public-stack.ts lib/miwkey-public-stack.js test/miwkey-public.test.ts test/miwkey-public.test.js
git diff --cached --check
git commit -m "fix(ecs): allow redundant task placement"
```

Expected: the commit contains `maxCapacity: 4`, the three ASG/ECS regression tests, and synchronized tracked JavaScript. It does not contain `.ai/`, `.claude/`, dependency upgrades, Managed Instances, or WARP changes.

### Task 4: Validate the deployable branch and create the extension infrastructure branch

**Files:**
- Verify only: synthesized `cdk.out/` output, which remains ignored.

**Interfaces:**
- Consumes: completed `feature/asg-stabilization` tip.
- Produces: `feature/notification-extension-infra` pointing at exactly the verified ASG stabilization tip.

- [ ] **Step 1: Run the complete local verification again from the committed tree**

Run:

```bash
mise exec -- npm ci
mise exec -- npm test -- --runInBand
mise exec -- npm run build
mise exec -- npm run synth -- --quiet
git status --short --branch
```

Expected: installation, four tests, build, and synth succeed. Status lists only the existing untracked `.ai/` and `.claude/` directories.

- [ ] **Step 2: Attempt a read-only deployment diff**

Run:

```bash
mise exec -- aws sts get-caller-identity --profile agent-readonly
mise exec -- npx cdk diff MiwkeyPublicStack --profile agent-readonly
```

Expected: STS identifies the configured account. If ViewOnlyAccess permits all reads required by CDK, the diff shows the ASG, launch template, IAM role, and ECS placement changes without deploying them. A denied read is recorded as an IAM limitation and does not replace the required local synthesis and assertion checks.

- [ ] **Step 3: Audit the final history and branch contents**

Run:

```bash
git log --oneline --decorate develop..feature/asg-stabilization
git diff --stat develop...feature/asg-stabilization
git diff --check develop...feature/asg-stabilization
```

Expected: history contains the AWS design document, the two restored ASG commits, the test fixture repair, and the capacity fix. The diff contains no full-refactor-only files or changes.

- [ ] **Step 4: Create the next branch without adding implementation**

Run:

```bash
git switch -c feature/notification-extension-infra
git rev-parse feature/asg-stabilization
git rev-parse feature/notification-extension-infra
```

Expected: both hashes are identical. The new branch contains no notification extension infrastructure changes yet and is ready for the separate implementation session.
