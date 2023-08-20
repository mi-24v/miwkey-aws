import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import * as MiwkeyPublic from '../lib/miwkey-public-stack';
import {loadNetworkProps} from "../lib/config/loader";
import {MiwkeyNetworkStack} from "../lib/miwkey-network";

const stackMock = jest.fn(() => {
    const app = new cdk.App();
    return new MiwkeyNetworkStack(app, 'MiwkeyNetworkTestStack', loadNetworkProps());
})

test('VPC and Subnets are Created', () => {
    const template = Template.fromStack(stackMock());

    template.hasResourceProperties('AWS::EC2::VPC', {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
    });
    template.resourceCountIs('AWS::EC2::Subnet', 3);
});
