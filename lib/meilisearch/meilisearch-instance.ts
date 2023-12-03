import {Duration, RemovalPolicy, Stack} from "aws-cdk-lib";
import {Construct} from "constructs";
import {MeilisearchInstanceProps} from "../types/stackprops";
import {
    BlockDeviceVolume,
    EbsDeviceVolumeType,
    Instance,
    InstanceClass,
    InstanceSize,
    InstanceType,
    MachineImage,
    SecurityGroup,
    SubnetSelection,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {IGrantable} from "aws-cdk-lib/aws-iam";
import {BlockPublicAccess, Bucket, BucketEncryption, StorageClass} from "aws-cdk-lib/aws-s3";


export class MeilisearchInstanceStack extends Stack {
    public readonly meilisearchInstance: Instance;
    public readonly meilisearchBackupStorage: Bucket;

    constructor(scope: Construct, id: string, props: MeilisearchInstanceProps) {
        super(scope, id, props);

        const instance= this.createMeilisearchInstance(this, props.instanceVpc, props.instanceSubnets, props.instanceSecurityGroup);
        this.meilisearchBackupStorage = this.createMeilisearchBackupStorage(this, instance.role);
        this.meilisearchInstance = instance
    }

    private createMeilisearchInstance(scope: Construct, vpc: Vpc, subnets: SubnetSelection, securityGroup: SecurityGroup): Instance {
        return new Instance(scope, "miwkey-meilisearch", {
            instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.MICRO),
            machineImage: MachineImage.lookup({
                name: "Meilisearch-v1.4.0-Debian-11",
                owners: ["567502172578"]
            }),
            vpc: vpc,
            blockDevices: [
                {
                    deviceName: "/dev/xvda",
                    volume: BlockDeviceVolume.ebs(50, {
                        deleteOnTermination: false,
                        encrypted: true,
                        volumeType: EbsDeviceVolumeType.GP3
                    })
                }
            ],
            detailedMonitoring: true,
            securityGroup: securityGroup,
            ssmSessionPermissions: true,
            vpcSubnets: subnets
        })
    }

    private createMeilisearchBackupStorage(scope: Construct, grantTarget: IGrantable) {
        const bucket = new Bucket(scope, "meilisearch-backup-s3", {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            encryption: BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            lifecycleRules: [
                {
                    enabled: true,
                    expiration: Duration.days(180),
                    prefix: "autoSnapshots/",
                    transitions: [
                        {
                            storageClass: StorageClass.GLACIER,
                            transitionAfter: Duration.days(30)
                        }
                    ]
                }
            ],
            removalPolicy: RemovalPolicy.RETAIN
        })
        bucket.grantReadWrite(grantTarget)
        return bucket
    }
}
