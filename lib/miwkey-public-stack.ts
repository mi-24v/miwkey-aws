import {aws_elasticache, Duration, RemovalPolicy, Stack} from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import {Construct} from 'constructs';
import {MiwkeyPublicStackProps} from "./types/stackprops";
import {FileSystem} from "aws-cdk-lib/aws-efs";
import {configFSPolicy} from "./iam-policies";
import {CfnCacheCluster} from "aws-cdk-lib/aws-elasticache";

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

        const queueSubnetGroup = new aws_elasticache.CfnSubnetGroup(this, "miwkeyQueueNetwork", {
            description: "subnet group for miwkey Redis",
            subnetIds: props.mainSubnets.map(s => s.subnetId),
            cacheSubnetGroupName: "miwkey-queue-network"
        })
        const postQueue = new CfnCacheCluster(this, "miwkeyQueueRedis", {
            cacheNodeType: "cache.t4g.micro",
            engine: "redis",
            numCacheNodes: 1,
            autoMinorVersionUpgrade: true,
            azMode: "single-az",
            cacheSubnetGroupName: queueSubnetGroup.cacheSubnetGroupName,
            engineVersion: "6.2",
            preferredMaintenanceWindow: "tue:19:00-tue:22:00", // 04:00JST-07:00JST
            snapshotRetentionLimit: 5,
            vpcSecurityGroupIds: [props.defaultSG.securityGroupId]
        })
        postQueue.node.addDependency(queueSubnetGroup)
    }
}
