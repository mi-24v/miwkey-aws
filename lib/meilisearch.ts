import {Construct} from "constructs";
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
import {Duration, RemovalPolicy} from "aws-cdk-lib";
import {BlockPublicAccess, Bucket, BucketEncryption, StorageClass} from "aws-cdk-lib/aws-s3";
import {IGrantable, ManagedPolicy, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {ARecord, PrivateHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {MiwkeyMeilisearchProps} from "./types/stackprops";
import {loadMeilisearchProps} from "./config/loader";


export function meilisearchInstance(scope: Construct, vpc: Vpc, subnets: SubnetSelection, securityGroup: SecurityGroup) {
    const instanceRole = new Role(scope, "miwkey-meiliseach-instance-role", {
        assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
        managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")]
    })
    const bucket = meilisearchBackupStorage(scope, instanceRole)
    const instance = new Instance(scope, "miwkey-meilisearch", {
        instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.MICRO),
        machineImage: MachineImage.lookup({
            name: "Meilisearch-v1.4.0-Debian-11",
            owners: ["567502172578"]
        }),
        vpc: vpc,
        blockDevices: [
            {
                deviceName: "/dev/nvme0n1p1",
                volume: BlockDeviceVolume.ebs(50, {
                    deleteOnTermination: false,
                    encrypted: true,
                    volumeType: EbsDeviceVolumeType.GP3
                })
            }
        ],
        detailedMonitoring: true,
        role: instanceRole,
        securityGroup: securityGroup,
        ssmSessionPermissions: true,
        vpcSubnets: subnets
    })
    const [zone, record] = meilisearchDNSRecord(scope, vpc, instance.instancePrivateIp, loadMeilisearchProps())
    instance.node.addDependency(bucket)
    return [instance, zone, record]
}

function meilisearchBackupStorage(scope: Construct, grantTarget: IGrantable) {
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

function meilisearchDNSRecord(scope: Construct, vpc: Vpc, instanceIp: string, props: MiwkeyMeilisearchProps): [PrivateHostedZone, ARecord] {
    const zone = new PrivateHostedZone(scope, "meilisearch-dns-zone", {
        vpc: vpc,
        zoneName: props.targetFQDN
    })
    const record = new ARecord(scope, "meilisearch-dns-record", {
        zone: zone,
        target: RecordTarget.fromIpAddresses(...instanceIp)
    })
    return [zone, record]
}
