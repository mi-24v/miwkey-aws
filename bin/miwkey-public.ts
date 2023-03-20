#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {MiwkeyPublicStack} from '../lib/miwkey-public-stack';
import {MiwkeyNetworkStack} from "../lib/miwkey-network";

const app = new cdk.App();
new MiwkeyNetworkStack(app, "MiwkeyNetworkStack");
new MiwkeyPublicStack(app, 'MiwkeyPublicStack');
