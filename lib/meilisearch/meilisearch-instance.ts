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
    UserData,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {
    Effect,
    IGrantable,
    ManagedPolicy,
    PolicyDocument,
    PolicyStatement,
    Role,
    ServicePrincipal
} from "aws-cdk-lib/aws-iam";
import {BlockPublicAccess, Bucket, BucketEncryption, StorageClass} from "aws-cdk-lib/aws-s3";


export class MeilisearchInstanceStack extends Stack {
    public readonly meilisearchInstance: Instance;
    public readonly meilisearchBackupStorage: Bucket;

    constructor(scope: Construct, id: string, props: MeilisearchInstanceProps) {
        super(scope, id, props);

        const instanceRole = this.createMeilisearchInstanceRole(this);
        this.meilisearchInstance = this.createMeilisearchInstance(this, props.instanceVpc, props.instanceSubnets, props.instanceSecurityGroup, instanceRole);
        this.meilisearchBackupStorage = this.createMeilisearchBackupStorage(this, instanceRole);
    }

    private createMeilisearchInstance(scope: Construct, vpc: Vpc, subnets: SubnetSelection, securityGroup: SecurityGroup, instanceRole: Role): Instance {
        const ssmSetupShell = UserData.forLinux()
        ssmSetupShell.addCommands(
            "mkdir /tmp/ssm",
            "cd /tmp/ssm",
            "wget https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_amd64/amazon-ssm-agent.deb",
            "sudo dpkg -i amazon-ssm-agent.deb",
            "sudo systemctl enable amazon-ssm-agent"
        )
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
            role: instanceRole,
            securityGroup: securityGroup,
            vpcSubnets: subnets,
            userData: ssmSetupShell
        })
    }

    private createMeilisearchInstanceRole(scope: Construct) {
        return new Role(scope, "miwkey-meiliseach-instance-role", {
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
            inlinePolicies: {
                "certbotDnsReadPolicy": new PolicyDocument({
                    assignSids: false,
                    minimize: false,
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                "route53:ListHostedZones",
                                "route53:GetChange"
                            ],
                            // ここで細かく指定すると通らなくなる
                            resources: ["*"]
                        })
                    ]
                }),
                "certbotDnsUpdatePolicy": new PolicyDocument({
                    assignSids: false,
                    minimize: false,
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                "route53:ChangeResourceRecordSets"
                            ],
                            // Zone側で指定できない(循環参照になる)ので仕方なくこうする
                            resources: [`arn:aws:route53:::hostedzone/*`]
                        })
                    ]
                })
            }
        });
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
