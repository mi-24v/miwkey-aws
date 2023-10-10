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


export function meilisearchInstance(scope: Construct, vpc: Vpc, subnets: SubnetSelection, securityGroup: SecurityGroup) {
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
        securityGroup: securityGroup,
        ssmSessionPermissions: true,
        vpcSubnets: subnets
    })
    return (instance)
}
