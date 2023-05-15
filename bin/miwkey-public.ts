#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {MiwkeyPublicStack} from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";
import {MiwkeyNetworkStackProps} from "../lib/types/stackprops";
import {loadNetworkProps} from "../lib/config/loader";

const app = new cdk.App();

const networkProps: MiwkeyNetworkStackProps = loadNetworkProps()

const network = new MiwkeyNetworkStack(app, "MiwkeyNetworkStack", networkProps);
const miwkey = new MiwkeyPublicStack(app, 'MiwkeyPublicStack', {
    mainVpc: network.miwkeyMainVpc,
    mainSubnets: network.miwkeyMainSubnets,
    defaultSG: network.miwkeyDefaultSG,
    domainCertificate: network.miwkeyDomainCertificate
});

miwkey.addDependency(network);
