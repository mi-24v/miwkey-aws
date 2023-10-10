#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {MiwkeyPublicStack} from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";
import {MiwkeyNetworkStackProps} from "../lib/types/stackprops";
import {loadEnvironment, loadNetworkProps} from "../lib/config/loader";
import {Environment} from "aws-cdk-lib";

const app = new cdk.App();

const env: Environment = loadEnvironment()
const networkProps: MiwkeyNetworkStackProps = {...loadNetworkProps(), ...{env: env}}

const network = new MiwkeyNetworkStack(app, "MiwkeyNetworkStack", networkProps);
const miwkey = new MiwkeyPublicStack(app, 'MiwkeyPublicStack', {
    mainVpc: network.miwkeyMainVpc,
    mainSubnets: network.miwkeyMainSubnets,
    defaultSG: network.miwkeyDefaultSG,
    loadBalancerSG: network.miwkeyLoadBalancerSG,
    domainCertificate: network.miwkeyDomainCertificate,
    env: env
});

miwkey.addDependency(network);
