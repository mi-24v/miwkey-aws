import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import * as MiwkeyPublic from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";
import {loadNetworkProps} from "../lib/config/loader";
import {App} from "aws-cdk-lib";

const app = new cdk.App()

const networkStack = jest.fn((app: App) => {
    return new MiwkeyNetworkStack(app, 'MiwkeyTestNetworkStack', loadNetworkProps());
})

const targetStack = jest.fn((app: App, network: MiwkeyNetworkStack) => {
    const stack = new MiwkeyPublic.MiwkeyPublicStack(app, 'MiwkeyTestStack', {
        mainVpc: network.miwkeyMainVpc,
        mainSubnets: network.miwkeyMainSubnets,
        defaultSG: network.miwkeyDefaultSG,
        loadBalancerSG: network.miwkeyLoadBalancerSG,
        domainCertificate: network.miwkeyDomainCertificate
    });
    stack.addDependency(network)
    return stack
})

test('Job Queue and Subnet Group Created', () => {
    const network = networkStack(app);
    const template = Template.fromStack(targetStack(app, network));

    template.hasResourceProperties('AWS::ElastiCache::CacheCluster', {
        CacheNodeType: "cache.t4g.micro",
        Engine: "redis",
        NumCacheNodes: 1,
        AutoMinorVersionUpgrade: true,
        AZMode: "single-az",
        CacheSubnetGroupName: "miwkey-queue-network",
        EngineVersion: "7.0",
        PreferredMaintenanceWindow: "tue:19:00-tue:22:00",
        SnapshotRetentionLimit: 5,
    });
    template.hasResourceProperties('AWS::ElastiCache::SubnetGroup', {
        SubnetIds: network.miwkeyMainSubnets.map(s => s.subnetId),
        CacheSubnetGroupName: "miwkey-queue-network"
    });
});
