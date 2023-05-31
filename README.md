# miwkey-aws

deployment script for https://miwkey.miwpayou0808.info/ on AWS

## CDK TypeScript project structure

CDK app with an instance of a stack (`MiwkeyPublicStack`), which contains:

* Amazon SQS queue 
  * future use for replacing redis.
* Amazon Elastic File System
  * for mounting ECS volume
* Amazon ElastiCache
  * for ActivityPub Redis Queue
* Amazon RDS
  * using in misskey's database
    * you can configure database username with `rdsUsername` Cfn Parameter
    * CLI: `--parameters MiwkeyPublicStack:rdsUsername="your_database_username"`
* `ApplicationLoadBalancedEc2Service`
  * L3 construct for EC2-ECS misskey app with Auto Scaling Group
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
