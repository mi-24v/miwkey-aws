#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MiwkeyPublicStack } from '../lib/miwkey-public-stack';

const app = new cdk.App();
new MiwkeyPublicStack(app, 'MiwkeyPublicStack');
