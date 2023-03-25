#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {MiwkeyPublicStack} from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";

const app = new cdk.App();

const network = new MiwkeyNetworkStack(app, "MiwkeyNetworkStack");
const miwkey = new MiwkeyPublicStack(app, 'MiwkeyPublicStack', {
    mainVpc: network.miwkeyMainVpc,
    mainSubnets: network.miwkeyMainSubnets,
    defaultSG: network.miwkeyDefaultSG
});

miwkey.addDependency(network);
