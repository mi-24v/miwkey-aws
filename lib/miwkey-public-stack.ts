import {aws_elasticache, CfnParameter, Duration, RemovalPolicy, Stack} from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import {Construct} from 'constructs';
import {MiwkeyPublicStackProps} from "./types/stackprops";
import {FileSystem} from "aws-cdk-lib/aws-efs";
import {configFSPolicy} from "./iam-policies";
import {CfnCacheCluster} from "aws-cdk-lib/aws-elasticache";
import {DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion, StorageType} from "aws-cdk-lib/aws-rds";
import {InstanceClass, InstanceSize, InstanceType, SubnetSelection} from "aws-cdk-lib/aws-ec2";
import {ApplicationLoadBalancedEc2Service} from "aws-cdk-lib/aws-ecs-patterns";
import {AddCapacityOptions, Cluster, ContainerDependencyCondition} from "aws-cdk-lib/aws-ecs";
import {ApplicationLoadBalancer} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {miwkeyConfigMountPoint, miwkeyMainTaskDefinition, miwkeyMigrationTaskDefinition} from "./taskdef";

export class MiwkeyPublicStack extends Stack {
    constructor(scope: Construct, id: string, props: MiwkeyPublicStackProps) {
        super(scope, id, props);
        const databaseUsername = new CfnParameter(this, "rdsUsername", {
            type: "String",
            default: "postgres"
        })
        const subnetSelection: SubnetSelection = {
            // 自前でIGW張ってるとpublic subnetがないと言われて自動指定できないので直接指定する
            subnets: props.mainSubnets
        }

        const queue = new sqs.Queue(this, 'MiwkeyPublicQueue', {
            visibilityTimeout: Duration.seconds(300)
        });

        const topic = new sns.Topic(this, 'MiwkeyPublicTopic');

        topic.addSubscription(new subs.SqsSubscription(queue));

        const configFs = new FileSystem(this, "miwkeyConfigFs", {
            vpc: props.mainVpc,
            vpcSubnets: subnetSelection,
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
            preferredMaintenanceWindow: "tue:19:00-tue:22:00", // wed 04:00JST-07:00JST
            snapshotRetentionLimit: 5,
            vpcSecurityGroupIds: [props.defaultSG.securityGroupId]
        })
        postQueue.node.addDependency(queueSubnetGroup)

        const mainDatabase = new DatabaseInstance(this, "miwkeyMainDB", {
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.of("15.2", "15")
            }),
            vpc: props.mainVpc,
            allocatedStorage: 50, // GiB
            allowMajorVersionUpgrade: false,
            autoMinorVersionUpgrade: true,
            backupRetention: Duration.days(7),
            credentials: {
                username: databaseUsername.valueAsString
            },
            deletionProtection: true,
            enablePerformanceInsights: true,
            iamAuthentication: true,
            instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
            monitoringInterval: Duration.seconds(60),
            preferredBackupWindow: "18:00-19:00", // 03:00-04:00JST
            preferredMaintenanceWindow: "tue:23:00-wed:00:00", // wed 08:00-09:00JST
            publiclyAccessible: false,
            storageEncrypted: true,
            securityGroups: [props.defaultSG],
            storageType: StorageType.GP3,
            vpcSubnets: subnetSelection
        });

        const ec2AutoScalingGroup: AddCapacityOptions = {
            instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
            capacityRebalance: true,
            desiredCapacity: 2,
            maxCapacity: 4,
            spotPrice: "0.01", // 7.2usd/mo
            ssmSessionPermissions: true,
            vpcSubnets: subnetSelection
        }
        const mainService = new ApplicationLoadBalancedEc2Service(this, "miwkeyMainService", {
            capacityProviderStrategies: [
                {
                    capacityProvider: "default",
                    base: 1,
                    weight: 200
                }
            ],
            cluster: new Cluster(this, "miwkeyEcsCluster", {
                capacity: ec2AutoScalingGroup,
                containerInsights: true,
                vpc: props.mainVpc
            }),
            certificate: props.domainCertificate,
            cpu: 1024,
            memoryReservationMiB: 1100,
            enableECSManagedTags: true,
            enableExecuteCommand: true,
            loadBalancer: new ApplicationLoadBalancer(this, "miwkeyMainLB", {
                vpc: props.mainVpc,
                vpcSubnets: subnetSelection,
                securityGroup: props.loadBalancerSG
            }),
            openListener: false,
            taskImageOptions: miwkeyMainTaskDefinition()
        });
        const volumeName = "misskey-config"
        mainService.taskDefinition.addVolume({
            name: volumeName,
            efsVolumeConfiguration: {
                fileSystemId: configFs.fileSystemId,
                transitEncryption: "ENABLED"
            }
        })
        const migration = mainService.taskDefinition.addContainer("miwkeyMigrationContainer", miwkeyMigrationTaskDefinition())
        migration.addMountPoints(miwkeyConfigMountPoint(volumeName))
        mainService.taskDefinition.defaultContainer?.addMountPoints(miwkeyConfigMountPoint(volumeName))
        mainService.taskDefinition.defaultContainer?.addContainerDependencies({
            container: migration,
            condition: ContainerDependencyCondition.SUCCESS
        })
    }
}
