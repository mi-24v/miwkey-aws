// Offline fixture entry point. Never use this app for deployment.
import {App} from 'aws-cdk-lib';
import {fixtureStack} from './stack';
const app = new App();
fixtureStack(app, process.env.EXTENSION_STAGE, process.env.EXTENSION_STAGING === 'true');
app.synth();
