# miwkey-aws

deployment script for https://miwkey.miwpayou0808.info/ on AWS

## CDK TypeScript project structure

CDK app with an instance of a stack (`MiwkeyPublicStack`), which contains:

* Amazon SQS queue 
  * that is subscribed to an Amazon SNS topic.
* `MiwkeyNetworkStack`
  * you need to assign IP addresses in `lib/config/ipAddress.example.json` and rename it into `lib/config/ipAddress.json`

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template
