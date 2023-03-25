import {Duration, RemovalPolicy, Stack} from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import {Construct} from 'constructs';
import {MiwkeyPublicStackProps} from "./types/stackprops";
import {FileSystem} from "aws-cdk-lib/aws-efs";
import {configFSPolicy} from "./iam-policies";

export class MiwkeyPublicStack extends Stack {
    constructor(scope: Construct, id: string, props: MiwkeyPublicStackProps) {
        super(scope, id, props);

        const queue = new sqs.Queue(this, 'MiwkeyPublicQueue', {
            visibilityTimeout: Duration.seconds(300)
        });

        const topic = new sns.Topic(this, 'MiwkeyPublicTopic');

        topic.addSubscription(new subs.SqsSubscription(queue));

        const configFs = new FileSystem(this, "miwkeyConfigFs", {
            vpc: props.mainVpc,
            vpcSubnets: {
                subnets: props.mainSubnets
            },
            encrypted: true,
            fileSystemPolicy: configFSPolicy,
            securityGroup: props.defaultSG,
            removalPolicy: RemovalPolicy.DESTROY
        })
    }
}
