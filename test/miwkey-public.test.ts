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

test('Jest resolves colocated stack imports to TypeScript sources', () => {
  expect(require.resolve('../lib/miwkey-public-stack')).toMatch(/\.ts$/);
});

test('ASG has capacity for redundant tasks and replacement headroom', () => {
  const template = createTemplate();

  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MaxSize: '4'
  });
});

test('ASG rolls launch template migration without dropping all instances', () => {
  const template = createTemplate();

  template.hasResource('AWS::AutoScaling::AutoScalingGroup', {
    UpdatePolicy: {
      AutoScalingRollingUpdate: {
        MaxBatchSize: 1,
        MinInstancesInService: 1,
        PauseTime: 'PT5M'
      }
    }
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
        Overrides: Match.arrayEquals([
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
    PlacementConstraints: Match.arrayEquals([
      { Type: 'distinctInstance' }
    ]),
    PlacementStrategies: Match.arrayEquals([
      { Field: 'MEMORY', Type: 'binpack' }
    ])
  });
});
