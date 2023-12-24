#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {Environment} from 'aws-cdk-lib';
import {MiwkeyPublicStack} from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";
import {MiwkeyNetworkStackProps} from "../lib/types/stackprops";
import {loadEnvironment, loadMeilisearchProps, loadNetworkProps} from "../lib/config/loader";
import {MeilisearchInstanceStack} from "../lib/meilisearch/meilisearch-instance";

const app = new cdk.App();

const env: Environment = loadEnvironment()
const networkProps: MiwkeyNetworkStackProps = {...loadNetworkProps(), ...{env: env}}

const network = new MiwkeyNetworkStack(app, "MiwkeyNetworkStack", networkProps);
const meilisearch = new MeilisearchInstanceStack(app, "MiwkeyMeilisearchStack", {
    instanceVpc: network.miwkeyMainVpc,
    instanceSubnets: {
        subnets: network.miwkeyMainSubnets
    },
    instanceSecurityGroup: network.miwkeyDefaultSG,
    env: env
});
const miwkey = new MiwkeyPublicStack(app, 'MiwkeyPublicStack', {
    mainVpc: network.miwkeyMainVpc,
    mainSubnets: network.miwkeyMainSubnets,
    defaultSG: network.miwkeyDefaultSG,
    loadBalancerSG: network.miwkeyLoadBalancerSG,
    domainCertificate: network.miwkeyDomainCertificate,
    meilisearchInstance: {
        meilisearchInstance: meilisearch.meilisearchInstance,
        ...loadMeilisearchProps()
    },
    env: env
});

meilisearch.addDependency(network)
miwkey.addDependency(network);
