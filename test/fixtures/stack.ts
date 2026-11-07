import {App, Stack} from 'aws-cdk-lib';
import {Certificate} from 'aws-cdk-lib/aws-certificatemanager';
import {SecurityGroup, Subnet, SubnetType, Vpc} from 'aws-cdk-lib/aws-ec2';
import {MiwkeyPublicStack} from '../../lib/miwkey-public-stack';
import {parseExtensionProps} from '../../lib/config/loader';
import {extensionFixture} from './extension';

export function fixtureStack(app: App, stage?: string, staging = false, hostAmiId = 'ami-0123456789abcdef0') {
  app.node.setContext('availability-zones:account=123456789012:region=us-east-1', ['us-east-1a', 'us-east-1b']);
  const support = new Stack(app, 'Support', {env: {account: '123456789012', region: 'us-east-1'}});
  const vpc = new Vpc(support, 'Vpc', {natGateways: 0, maxAzs: 2,
    subnetConfiguration: [{name: 'public', subnetType: SubnetType.PUBLIC}]});
  const stack = new MiwkeyPublicStack(app, 'TestStack', {
    env: {account: '123456789012', region: 'us-east-1'},
    hostAmiId, // Fixture only, never a production selection.
    mainVpc: vpc, mainSubnets: vpc.publicSubnets as Subnet[],
    defaultSG: new SecurityGroup(support, 'DefaultSG', {vpc}),
    loadBalancerSG: new SecurityGroup(support, 'LbSG', {vpc}),
    domainCertificate: Certificate.fromCertificateArn(support, 'Cert', 'arn:aws:acm:us-east-1:123456789012:certificate/fixture'),
    extension: stage ? parseExtensionProps({...extensionFixture, stage, staging, monitoringStart: stage === 'scheduled' ? '2026-10-17T00:00:00Z' : undefined, alertEmail: 'operator@example.com'}) : undefined,
  });
  return stack;
}
