import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {fixtureStack} from './fixtures/stack';
import {readFileSync} from 'fs';
import * as path from 'path';

const appContext = JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')).context;

function synth(stage: string | undefined, minimizePolicies: boolean) {
  return Template.fromStack(fixtureStack(new App({context: {
    ...appContext, '@aws-cdk/aws-iam:minimizePolicies': minimizePolicies,
  }}), stage));
}

// Compare permissions independently of CDK merging and ordering statements.
function individualActions(statements: any[]) {
  return statements.flatMap(({Action, ...scope}) => [Action].flat().map(action => ({...scope, Action: action})))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function instancePermissions(template: Template) {
  template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
  const [profileId, profile] = Object.entries(template.findResources('AWS::IAM::InstanceProfile'))[0];
  expect(profile.Properties.Roles).toHaveLength(1);
  const roleId = profile.Properties.Roles[0].Ref;
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {IamInstanceProfile: {Arn: {'Fn::GetAtt': [profileId, 'Arn']}}},
  });
  const role = template.findResources('AWS::IAM::Role')[roleId];
  expect(role.Properties.AssumeRolePolicyDocument.Statement).toContainEqual({
    Action: 'sts:AssumeRole', Effect: 'Allow', Principal: {Service: 'ec2.amazonaws.com'},
  });
  const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(policy => policy.Properties.Roles?.some((ref: any) => ref.Ref === roleId));
  expect(policies).toHaveLength(1);
  return {roleId, role, policy: policies[0], statements: policies[0].Properties.PolicyDocument.Statement as any[]};
}

const pollGrant = {Action: 'ecs:Poll', Effect: 'Allow', Resource: '*'};

describe.each([appContext['@aws-cdk/aws-iam:minimizePolicies'], false])(
  'Service Connect container instance permissions with minimizePolicies=%s', minimizePolicies => {
    let disabled: Template;
    beforeAll(() => { disabled = synth(undefined, minimizePolicies); });

    test('disabled extension retains every existing host permission and scope', () => {
      const {statements} = instancePermissions(disabled);
      const clusterId = disabled.getResourceId('AWS::ECS::Cluster');
      expect(individualActions(statements)).toEqual(individualActions([
        {
          Action: ['ecs:DeregisterContainerInstance', 'ecs:RegisterContainerInstance', 'ecs:Submit*'],
          Effect: 'Allow', Resource: {'Fn::GetAtt': [clusterId, 'Arn']},
        },
        {
          Action: ['ecs:Poll', 'ecs:StartTelemetrySession'],
          Condition: {ArnEquals: {'ecs:cluster': {'Fn::GetAtt': [clusterId, 'Arn']}}},
          Effect: 'Allow', Resource: '*',
        },
        {
          Action: ['ecs:DiscoverPollEndpoint', 'ecr:GetAuthorizationToken', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          Effect: 'Allow', Resource: '*',
        },
      ]));
    });

    test.each(['bootstrap', 'service', 'client', 'scheduled'])(
      '%s grants only unconditional Poll to the EC2 instance role and preserves existing permissions', stage => {
        const enabled = synth(stage, minimizePolicies);
        const baseline = instancePermissions(disabled);
        const host = instancePermissions(enabled);
        const permissions = individualActions(host.statements);
        expect(permissions.filter(statement => statement.Condition === undefined &&
          [statement.Action].flat().includes('ecs:Poll'))).toEqual([pollGrant]);

        // Removing only unconditional Poll must restore every existing host permission.
        expect({
          ...host.policy,
          Properties: {
            ...host.policy.Properties,
            PolicyDocument: {
              ...host.policy.Properties.PolicyDocument,
              Statement: permissions.filter(statement => statement.Condition !== undefined || statement.Action !== 'ecs:Poll'),
            },
          },
        }).toEqual({
          ...baseline.policy,
          Properties: {
            ...baseline.policy.Properties,
            PolicyDocument: {...baseline.policy.Properties.PolicyDocument, Statement: individualActions(baseline.statements)},
          },
        });
        expect(host.role).toEqual(baseline.role);

        // Poll must never be added to task, execution, issuer, or scheduler roles.
        const pollPolicies = Object.values(enabled.findResources('AWS::IAM::Policy')).filter(policy =>
          policy.Properties.PolicyDocument.Statement.some((statement: any) => [statement.Action].flat().includes('ecs:Poll')));
        expect(pollPolicies).toHaveLength(1);
        expect(pollPolicies[0].Properties.Roles).toEqual([{Ref: host.roleId}]);
      },
    );
  },
);
