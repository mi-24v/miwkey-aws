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
