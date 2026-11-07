import {Construct} from "constructs";
import {Vpc} from "aws-cdk-lib/aws-ec2";
import {ARecord, PrivateHostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {MiwkeyMeilisearchInstanceProps} from "../types/stackprops";


export function meilisearchDNSRecord(scope: Construct, vpc: Vpc, props: MiwkeyMeilisearchInstanceProps): [PrivateHostedZone, ARecord] {
    const zone = new PrivateHostedZone(scope, "meilisearch-dns-zone", {
        vpc: vpc,
        zoneName: props.targetFQDN
    })
    const record = new ARecord(scope, "meilisearch-dns-record", {
        zone: zone,
        target: RecordTarget.fromIpAddresses(...[props.meilisearchInstance.instancePrivateIp])
    })
    zone.node.addDependency(props.meilisearchInstance)
    record.node.addDependency(zone)
    return [zone, record]
}
