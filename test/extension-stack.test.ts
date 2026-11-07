import {App} from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {fixtureStack} from './fixtures/stack';
import {extensionFixture} from './fixtures/extension';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'fs';
import * as path from 'path';

function synth(stage?: string, staging = false) {
  return Template.fromStack(fixtureStack(new App(), stage, staging));
}

test('issuer asset contains all build inputs and excludes Python and development assets', () => {
  const outdir = mkdtempSync(path.join(__dirname, '../.cdk.staging-'));
  try {
    const app = new App({outdir});
    const stack = fixtureStack(app, 'bootstrap');
    app.synth();
    const manifest = JSON.parse(readFileSync(path.join(outdir, `${stack.artifactId}.assets.json`), 'utf8'));
    const images = Object.values(manifest.dockerImages) as any[];
    expect(images).toHaveLength(1);
    expect(images[0].source.platform).toBe('linux/amd64');
    expect(images[0].source.dockerFile).toBe('lambda/extension-cert-issuer/Dockerfile');
    const directory = path.join(outdir, images[0].source.directory);
    const files = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.relative(directory, path.join(dir, entry.name))]);
    const issuer = 'lambda/extension-cert-issuer/';
    const required = ['.dockerignore', 'package.json', 'package-lock.json', 'vendor/acme-client-native/acme-client-native-5.4.0-miwkey.1.tgz',
      ...['Dockerfile', 'package.json', 'tsconfig.json', 'runtime-pins.json', 'trust.json',
        'public-roots.pem', 'staging-roots.pem',
        ...['acme', 'aws', 'certificate', 'dns', 'errors', 'handler', 'workflow'].map(name => `src/${name}.ts`)].map(name => issuer + name)];
    expect(files(directory).sort()).toEqual(required.sort());
    for (const name of required) {
      expect(readFileSync(path.join(directory, name))).toEqual(readFileSync(path.join(__dirname, '..', name)));
    }
  } finally {
    rmSync(outdir, {recursive: true, force: true});
  }
});

test('disabled integration has no extension resources or client settings', () => {
  const t = synth();
  t.resourceCountIs('AWS::DynamoDB::Table', 0);
  t.resourceCountIs('AWS::Scheduler::Schedule', 0);
  expect(JSON.stringify(t.toJSON())).not.toContain('NOTIFICATION_EXTENSION');
});

test.each(['bootstrap', 'service', 'client', 'scheduled'])('stage %s creates only the intended services and schedule', stage => {
  const t = synth(stage);
  t.resourceCountIs('AWS::ECS::Service', stage === 'bootstrap' ? 1 : 2);
  t.hasResourceProperties('AWS::Scheduler::Schedule', {
    State: stage === 'scheduled' ? 'ENABLED' : 'DISABLED',
    Target: Match.objectLike({RetryPolicy: {MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0}}),
  });
  t.hasResourceProperties('AWS::Lambda::Function', {PackageType: 'Image', Architectures: ['x86_64'], Timeout: 900, ReservedConcurrentExecutions: 1, VpcConfig: Match.absent()});
  t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0});
  t.resourceCountIs('AWS::SNS::Topic', 1);
  t.resourceCountIs('AWS::SQS::Queue', 1);
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST', PointInTimeRecoverySpecification: {PointInTimeRecoveryEnabled: true},
    KeySchema: [{AttributeName: 'notifieeId', KeyType: 'HASH'}, {AttributeName: 'sortKey', KeyType: 'RANGE'}],
    GlobalSecondaryIndexes: [Match.objectLike({IndexName: 'notificationId-index', KeySchema: [{AttributeName: 'id', KeyType: 'HASH'}], Projection: {ProjectionType: 'ALL'}})],
  });
  const json = t.toJSON();
  const secrets = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::SecretsManager::Secret') as any[];
  const jwt = Object.entries(json.Resources).find(([id]) => id.startsWith('NotificationExtensionJwt'))![1] as any;
  expect(jwt.DeletionPolicy).toBe('Retain');
  expect(jwt.UpdateReplacePolicy).toBe('Retain');
  expect(secrets).toHaveLength(5); // JWT, certificate, account, token, RDS credentials.
  for (const secret of secrets.filter(s => !s.Properties?.GenerateSecretString)) {
    expect(secret.Properties?.SecretString).toBeUndefined();
    expect(secret.DeletionPolicy).toBe('Retain');
  }
  const text = JSON.stringify(json);
  expect(text).not.toMatch(/route53:|dynamodb:CreateTable|dynamodb:UpdateTable/);
  expect(text).not.toContain('AWS::Route53::');
  t.hasResourceProperties('AWS::SNS::Subscription', {Protocol: 'email'});
  expect(text).not.toContain('\"Protocol\":\"sqs\"');
  expect(text).not.toContain('DYNAMODB_AUTO_CREATE');
  expect(text).not.toContain('IngressPortOverride');
  if (stage !== 'bootstrap') {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      NetworkMode: 'bridge', Cpu: '512', Memory: '1024',
      ContainerDefinitions: [Match.objectLike({
        Image: extensionFixture.image,
        HealthCheck: Match.objectLike({Command: ['CMD', '/miwkey-extension', 'healthcheck']}),
        PortMappings: [{ContainerPort: 8080, HostPort: 0, Name: 'extension-tls', Protocol: 'tcp'}],
      })],
    });
    t.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'miwkey-extension', DesiredCount: 2,
      ServiceConnectConfiguration: Match.objectLike({Services: [{PortName: 'extension-tls', ClientAliases: [{DnsName: 'notifications.example.com', Port: 8080}]}]}),
    });
  }
  const defs = Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::ECS::TaskDefinition') as any[];
  const main = defs.find(d => d.Properties.ContainerDefinitions.length === 2).Properties;
  const configured = stage === 'client' || stage === 'scheduled';
  expect(JSON.stringify(main)).toContain('/misskey/.config/ap-northeast-1-bundle.pem');
  expect(JSON.stringify(main.ContainerDefinitions[1])).not.toContain('NOTIFICATION_EXTENSION');
  expect(JSON.stringify(main).includes('NOTIFICATION_EXTENSION_URL')).toBe(configured);
  if (configured) {
    expect(main.Cpu).toBe('1280'); expect(main.Memory).toBe('2048');
    expect(JSON.stringify(main)).toContain('https://notifications.example.com:8080');
  }
});

test('staging rehearsal secrets are temporary and absent after bootstrap', () => {
  const t = synth('bootstrap', true);
  t.resourceCountIs('AWS::SecretsManager::Secret', 7);
  const secrets = Object.values(t.toJSON().Resources).filter((r: any) => r.Type === 'AWS::SecretsManager::Secret') as any[];
  expect(secrets.filter(r => r.DeletionPolicy === 'Delete' && !r.Properties?.GenerateSecretString)).toHaveLength(2);
});

test('integration leaves ALB, RDS, EFS and host security groups unchanged', () => {
  const baseline = synth().toJSON(), enabled = synth('scheduled').toJSON();
  for (const [id, resource] of Object.entries(baseline.Resources) as [string, any][]) {
    if (/AWS::(RDS|EFS|ElasticLoadBalancingV2)::/.test(resource.Type)) expect(enabled.Resources[id]).toEqual(resource);
  }
  const launch = (t: any) => Object.values(t.Resources).find((r: any) => r.Type === 'AWS::EC2::LaunchTemplate') as any;
  expect(launch(enabled).Properties.LaunchTemplateData.SecurityGroupIds).toEqual(launch(baseline).Properties.LaunchTemplateData.SecurityGroupIds);
});

test('secret permissions separate issuer, application and execution roles', () => {
  const r = synth('scheduled').toJSON().Resources;
  const policies = Object.entries(r).filter(([, v]: any) => v.Type === 'AWS::IAM::Policy') as [string, any][];
  const tokenId = Object.keys(r).find(id => id.includes('CloudflareToken'))!;
  const certId = Object.keys(r).find(id => id.startsWith('NotificationExtensionCertificate'))!;
  const readers = (secret: string) => policies.filter(([, p]) => p.Properties.PolicyDocument.Statement.some((s: any) =>
    JSON.stringify(s.Resource).includes(secret) && [s.Action].flat().includes('secretsmanager:GetSecretValue'))).map(([id]) => id);
  expect(readers(tokenId)).toEqual([expect.stringContaining('IssuerRole')]);
  expect(readers(certId)).toEqual(expect.arrayContaining([expect.stringContaining('IssuerRole'), expect.stringContaining('TaskTaskRole')]));
  expect(readers(certId)).toHaveLength(2);
  const issuer = policies.find(([id]) => id.includes('IssuerRole'))![1].Properties.PolicyDocument.Statement;
  const get = (action: string) => issuer.find((s: any) => [s.Action].flat().includes(action));
  expect(JSON.stringify(get('ecs:UpdateService').Resource)).toContain('/miwkey-extension');
  expect(JSON.stringify(get('ecs:UpdateService').Resource)).not.toContain('NotificationExtensionService');
  expect(get('cloudwatch:PutMetricData').Condition).toEqual({StringEquals: {'cloudwatch:namespace': 'Miwkey/ExtensionCertificate'}});
  expect(JSON.stringify(get('logs:FilterLogEvents').Resource)).toContain('/ecs/miwkey-extension/app:*');
  expect(JSON.stringify(get('logs:PutLogEvents').Resource)).toContain('IssuerLogs');
  expect(issuer.flatMap((s: any) => [s.Action].flat())).not.toContain('sns:Publish');
  expect(get('ecs:ListTasks').Condition.ArnEquals['ecs:cluster']).toBeDefined();
  const resources = Object.entries(r) as [string, any][];
  const extensionId = resources.find(([, v]) => v.Type === 'AWS::ECS::Service' && v.Properties.ServiceName === 'miwkey-extension')![0];
  const main = resources.find(([, v]) => v.Type === 'AWS::ECS::Service' && !v.Properties.ServiceName)![1];
  expect(main.DependsOn).toContain(extensionId);
  expect(main.Properties.ServiceConnectConfiguration.Services).toBeUndefined();
});

test('stage transitions never change both service definitions together', () => {
  const service = synth('service').toJSON().Resources;
  const client = synth('client').toJSON().Resources;
  const scheduled = synth('scheduled').toJSON().Resources;
  for (const [id, r] of Object.entries(client) as [string, any][]) {
    if (r.Type === 'AWS::ECS::Service' || r.Type === 'AWS::ECS::TaskDefinition') expect(scheduled[id]).toEqual(r);
    if (id.startsWith('NotificationExtension') && (r.Type === 'AWS::ECS::Service' || r.Type === 'AWS::ECS::TaskDefinition')) expect(service[id]).toEqual(r);
  }
  const disabled = synth().toJSON().Resources;
  for (const [id, r] of Object.entries(disabled) as [string, any][]) {
    if (r.Type === 'AWS::SNS::Topic' || r.Type === 'AWS::SQS::Queue') expect(scheduled[id]).toEqual(r);
  }
});

test('bootstrap owns retained log groups across rollback and re-entry', () => {
  const names = ['/ecs/miwkey-extension/app', '/ecs/miwkey-extension/service-connect', '/ecs/miwkey/service-connect'];
  const stages = ['bootstrap', 'service', 'bootstrap', 'service', 'client', 'service', 'client'];
  let owned: any;
  for (const stage of stages) {
    const resources = synth(stage).toJSON().Resources;
    const groups = Object.fromEntries(Object.entries(resources).filter(([, r]: any) => names.includes(r.Properties?.LogGroupName)));
    expect(Object.keys(groups)).toHaveLength(3);
    for (const r of Object.values(groups) as any[]) {
      expect(r.DeletionPolicy).toBe('Retain'); expect(r.UpdateReplacePolicy).toBe('Retain');
      expect(r.Properties.RetentionInDays).toBe(180);
    }
    if (owned) expect(groups).toEqual(owned);
    owned = groups;
  }
});

test('bootstrap to service changes no existing Misskey resource', () => {
  const before = synth('bootstrap').toJSON().Resources;
  const after = synth('service').toJSON().Resources;
  for (const [id, r] of Object.entries(before)) {
    if (id.startsWith('miwkeyMainService')) expect(after[id]).toEqual(r);
  }
});

test('heartbeat monitoring has a real startup grace, two missing intervals and no disabled alarm state', () => {
  for (const stage of ['bootstrap', 'service', 'client']) {
    expect(Object.keys(synth(stage).toJSON().Resources).some(id => id.includes('MissingTelemetry'))).toBe(false);
  }
  const t = synth('scheduled');
  const alarm = Object.entries(t.toJSON().Resources).find(([id]) => id.includes('MissingTelemetry'))![1] as any;
  expect(alarm.Properties.ActionsEnabled).toBe(true);
  expect(alarm.Properties.EvaluationPeriods).toBe(2);
  expect(alarm.Properties.DatapointsToAlarm).toBe(2);
  expect(alarm.Properties.Metrics).toEqual(expect.arrayContaining([expect.objectContaining({
    Expression: 'IF(EPOCH(TIME_SERIES(0)) < 1792368000, 1, FILL(heartbeat, 0))',
  })]));
  t.hasResourceProperties('AWS::Scheduler::Schedule', {StartDate: '2026-10-17T00:00:00Z'});
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {MetricName: 'ApplyDelayDays', Threshold: 2, ComparisonOperator: 'GreaterThanOrEqualToThreshold'});
});

test('all extension stages preserve the pinned host template and only explicit AMI changes replace its image', () => {
  const baseline = synth().toJSON().Resources;
  const launchId = Object.keys(baseline).find(id => baseline[id].Type === 'AWS::EC2::LaunchTemplate')!;
  for (const stage of ['bootstrap', 'service', 'client', 'scheduled']) {
    expect(synth(stage).toJSON().Resources[launchId]).toEqual(baseline[launchId]);
  }
  const changed = Template.fromStack(fixtureStack(new App(), undefined, false, 'ami-fedcba98765432100')).toJSON().Resources;
  expect(changed[launchId].Properties.LaunchTemplateData.ImageId).toBe('ami-fedcba98765432100');
  for (const [id, resource] of Object.entries(baseline)) {
    if (id !== launchId) expect(changed[id]).toEqual(resource);
  }
});
