# miwkey-extension AWS Integration Design

- Date: 2026-07-22
- Updated: 2026-07-27
- Status: Approved for implementation
- Repositories: `miwkey-aws`, `miwkey-extension`, `miwkey-notification-importer`

## 1. Goal

Deploy `miwkey-extension` as an internal-only ECS service, connect the Misskey
backend through ECS Service Connect, and provide the persistent notification
store required before upgrading from Misskey 12.119.0.

The work is split so the current ASG availability fix can be reviewed and
deployed independently from the notification extension resources. The existing
`feature/full-refactor` branch remains untouched until both smaller branches
have been merged.

## 2. Scope

This design covers:

- the minimal ASG stabilization branch in `miwkey-aws`
- the AWS resources for the notification extension
- the cross-repository interface required from `miwkey-extension`
- the internal migration path for `miwkey-notification-importer`
- deployment, rollback, logging, and verification

This design does not cover:

- building or publishing the Misskey fork image
- the Misskey 2025 application image cutover
- database migration concurrency control for the major-version upgrade
- execution of the production notification import
- ECS Managed Instances, WARP, or the other full-refactor changes
- an externally accessible notification extension endpoint

## 3. Branch Structure

Create the following branches in `miwkey-aws`:

```text
develop
└─ 67024a6  placement strategy
   └─ e9f190e  MixedInstancesPolicy
      └─ test(ecs): repair stack test setup
         └─ fix(ecs): allow redundant task placement
            └─ feature/asg-stabilization
               └─ notification extension infrastructure commits
                  └─ feature/notification-extension-infra
```

Apart from this design document, `feature/asg-stabilization` contains only these
runtime and test changes:

- the existing changes from `67024a6` and `e9f190e`
- the test setup repair needed to instantiate `MiwkeyPublicStack`
- `maxCapacity: 4`
- migration from the existing launch configuration to the launch template with
  `migrateToLaunchTemplate: true`
- a rolling update policy with a maximum batch size of one, at least two
  instances in service, and a five-minute pause
- regression assertions for ASG `MaxSize`, ECS `DesiredCount`, the
  `distinctInstance` placement constraint, the six Spot instance types, and
  the `capacity-optimized` allocation strategy
- a synthesized-template assertion for top-level
  `UpdatePolicy.AutoScalingRollingUpdate`

Repository tooling pins only the `aws-cdk` CLI to `2.1132.0`; `aws-cdk-lib`
remains on 2.217.x. The branch does not contain a CDK library upgrade, Managed
Instances design, WARP PoC, or the full-refactor `.gitignore` changes.

Create `feature/notification-extension-infra` from the completed
`feature/asg-stabilization` tip. Keep `feature/full-refactor` at its current
commit. After both smaller branches are merged, rebase `feature/full-refactor`
onto the updated `develop` and drop the now-duplicate max-capacity and test
setup changes.

The notification extension branch changes the ASG Spot allocation strategy
from `capacity-optimized` to `price-capacity-optimized`. The strategy applies
to future instance launches. Do not start an Instance Refresh or deliberately
replace the existing instances as part of this branch; they remain until a
normal scaling, health replacement, Spot interruption, or capacity rebalance
event launches replacements.

## 4. Runtime Architecture

Run the extension as an independent ECS EC2 service in the same cluster as
Misskey. Do not run it as a Misskey sidecar and do not add an internal or public
load balancer.

```text
Misskey container
  -> Service Connect client proxy
  -> http://miwkey-extension:8080
  -> Service Connect server proxy
  -> miwkey-extension container
  -> DynamoDB Notifications table
```

The Misskey service joins the namespace as a client-only Service Connect
service. The extension joins as a client-server service and publishes the
`miwkey-extension` alias on port 8080.

The extension ECS service uses:

- EC2 capacity through the existing ASG capacity provider
- bridge network mode
- `desiredCount: 2`
- `distinctInstances()` so both extension tasks cannot use the same container
  instance
- a deployment circuit breaker with rollback enabled
- a named HTTP port mapping for container port 8080
- the public GHCR image pinned to an immutable `sha-<commit>` tag

The existing VPC security group allows traffic within the VPC, and the current
network ACL permits the bridge-mode ephemeral port range. No public listener or
DNS record is created for the extension.

The server ECS service must be created successfully before CloudFormation
updates the existing Misskey service with its Service Connect client
configuration. Express this ordering as a resource dependency.

## 5. AWS Resources

### 5.1 Container Image Parameter

Add a required CloudFormation parameter for the extension image tag. Accept
only immutable `sha-<commit>` tags and construct this image reference:

```text
ghcr.io/mi-24v/miwkey-extension:sha-<commit>
```

Do not use `latest` in an ECS task definition. The GHCR package is public, so
the task execution role does not need a GitHub token or repository credentials.

### 5.2 DynamoDB

Create the notification table in CDK with:

- partition key: `notifieeId` (`String`)
- sort key: `sortKey` (`String`)
- global secondary index: `notificationId-index`
- GSI partition key: `id` (`String`)
- GSI projection: `ALL`
- billing mode: on-demand
- point-in-time recovery: enabled
- removal policy: `RETAIN`

Grant only read/write data access on this table to the extension task role.
The task role must not receive `CreateTable`, `UpdateTable`, or unrelated
DynamoDB permissions.

Production must leave `DYNAMODB_AUTO_CREATE` unset. CDK is the only production
schema owner. The existing auto-create behavior remains available for DynamoDB
Local and integration tests, where `DYNAMODB_AUTO_CREATE=true` is appropriate.

### 5.3 Shared JWT Secret

Create one generated Secrets Manager secret and set its removal policy to
`RETAIN`. Inject the value through ECS secrets as:

- `AUTH_SECRET` in the extension container
- `NOTIFICATION_EXTENSION_SECRET` in the Misskey container

Set this non-secret environment variable in Misskey:

```text
NOTIFICATION_EXTENSION_URL=http://miwkey-extension:8080
```

Do not place the secret value in CloudFormation parameters, task-definition
plain-text environment variables, source-controlled config, or logs.

Do not configure automatic secret rotation. Rotation requires a coordinated
redeployment of both ECS services. The manual rotation procedure is:

1. update the Secrets Manager value
2. force a new extension service deployment
3. force a new Misskey service deployment
4. verify authenticated requests through the internal endpoint

### 5.4 Outputs

Export enough non-secret identifiers for operation and migration:

- ECS cluster name
- extension ECS service name
- Service Connect namespace name
- DynamoDB table name
- secret ARN

Never output the secret value.

## 6. Cross-Repository Contract

The separate `miwkey-extension` implementation must provide:

- Misskey support for `NOTIFICATION_EXTENSION_URL`
- Misskey support for `NOTIFICATION_EXTENSION_SECRET`
- a public multi-architecture extension image at
  `ghcr.io/mi-24v/miwkey-extension:sha-<commit>`
- an unauthenticated `GET /healthz` endpoint
- a distroless-compatible container health check
- the logging contract described below

Environment variables take precedence over YAML values. YAML remains a
fallback for local development. The integration is enabled only when both URL
and secret are present.

Building and publishing the Misskey fork image belongs to the fork repository,
not the `miwkey-extension` CI workflow. The fork image cutover and its database
migration orchestration are separate work.

## 7. Logging

Keep two log groups with six-month retention:

```text
/ecs/miwkey-extension/app
/ecs/miwkey-extension/service-connect
```

The application log group contains:

- Echo request metadata
- startup and graceful shutdown events
- panic/recover output
- DynamoDB and AWS configuration errors without payload data

The Service Connect log group contains proxy startup and connectivity errors.
Service Connect request access logs are disabled initially because Echo already
logs request metadata and duplicate access logs add cost and can expose query
parameters such as user IDs.

Neither log group may contain notification payloads, JWTs, Authorization
headers, or the shared secret.

## 8. Importer Access

Service Connect does not support standalone ECS tasks, and the extension has no
load balancer. Run the one-time importer from the operator machine through an
SSM port-forwarding session:

1. find one running extension task
2. read its bridge-mode dynamic `hostPort` from the ECS task network binding
3. resolve the backing ECS container instance and EC2 instance ID
4. open an SSM port forward from a local port to
   `127.0.0.1:<hostPort>` on that instance
5. run the importer against the local forwarded URL
6. authenticate with a short-lived JWT generated from the shared secret
7. close the session after import and verification

The existing ECS container-instance role already includes
`AmazonSSMManagedInstanceCore`. The production operator needs explicit
permission to start the SSM session and read the shared secret. The extension's
JWT middleware remains active on the forwarded connection.

Document the exact AWS CLI commands after the first deployed task exists,
because the task ARN, container instance, EC2 instance, and dynamic host port
are deployment-time values.

## 9. Deployment Order

1. Complete a cloud diff with credentials able to assume the CDK lookup role,
   then merge and deploy `feature/asg-stabilization` by itself.
2. Verify that two Misskey tasks remain placed on distinct instances and that
   Spot replacement works with the diversified pools.
3. Complete the `miwkey-extension` cross-repository contract and change the ASG
   Spot allocation strategy to `price-capacity-optimized`.
4. Confirm the Change Set updates the existing ASG in place and does not
   initiate an Instance Refresh.
5. Merge `feature/notification-extension-infra`.
6. Deploy with a known public multi-architecture `sha-<commit>` image tag.
7. Verify two healthy extension tasks and authenticated access through an SSM
   tunnel.
8. In a separate change, deploy the Misskey 2025 image that consumes the URL
   and secret environment variables.
9. Perform the rehearsed notification import and verify migrated IDs.
10. Rebase and continue `feature/full-refactor` only after the two smaller
   branches are merged and stable.

## 10. Failure and Rollback

- The extension deployment circuit breaker rolls back failed task revisions.
- A failed new server service prevents the dependent Misskey Service Connect
  update from starting.
- Rolling back the AWS code does not delete the retained table or secret.
- Rolling back the application uses the previous Misskey task definition while
  preserving imported DynamoDB data.
- If the extension is temporarily unavailable, the current Misskey fork treats
  requests as failed and falls back according to its existing notification
  behavior. Do not treat this as a durable retry guarantee.
- Do not combine the ASG deployment, extension infrastructure deployment, and
  Misskey major-version cutover into one CloudFormation update.

## 11. Verification

### ASG branch

- TypeScript build passes.
- Jest passes.
- Synthesized ASG has `MaxSize: 4`.
- Synthesized ASG has top-level `UpdatePolicy.AutoScalingRollingUpdate` with
  `MaxBatchSize: 1`, `MinInstancesInService: 2`, and `PauseTime: PT5M`.
- Main ECS service has `DesiredCount: 2` and `MinimumHealthyPercent: 100`.
- The service uses `distinctInstance`.
- The ASG contains all six intended Graviton instance types.
- Spot allocation uses `capacity-optimized`.
- The Change Set was reviewed with credentials able to perform the required
  CloudFormation operations, and the ASG branch deployment completed.

### Notification extension infrastructure branch

- TypeScript build and Jest pass.
- CDK synthesis passes in the available environment.
- The table schema, GSI, PITR, and retain policy match this design.
- The secret is injected through ECS secrets, not plain-text environment data.
- The extension task role can access only the notification table.
- The extension service advertises `miwkey-extension:8080` through Service
  Connect.
- The Misskey service is a client and depends on the server service creation.
- The extension service runs two tasks on distinct instances.
- Spot allocation uses `price-capacity-optimized`.
- The ASG update does not replace the group or initiate an Instance Refresh.
- No extension ALB, public listener, or public DNS record exists.
- Application and Service Connect logs use separate six-month log groups.
- Service Connect request access logging is disabled.

## 12. References

- [Amazon ECS Service Connect](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html)
- [Service Connect configuration overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts.html)
- [Service Connect components and bridge networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts-deploy.html)
- [Connecting ECS services inside a VPC](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/networking-connecting-services.html)
- [Auto Scaling allocation strategies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/allocation-strategies.html)
- [Updating an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/update-auto-scaling-group.html)
