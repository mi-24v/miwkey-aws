import {aws_ec2, RemovalPolicy, Stack} from "aws-cdk-lib";
import {Construct} from "constructs";
import {
    AclCidr,
    AclTraffic,
    Action,
    CfnInternetGateway,
    CfnVPCPeeringConnection,
    CommonNetworkAclEntryOptions,
    NetworkAcl,
    Peer,
    Port,
    RouterType,
    SecurityGroup,
    Subnet,
    TrafficDirection,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {Certificate, ICertificate} from "aws-cdk-lib/aws-certificatemanager";
import {MiwkeyNetworkStackProps} from "./types/stackprops";
import {OnlyCloudflareIngressRules} from "./security";


const basicNetAclList: CommonNetworkAclEntryOptions[] = [
    {// ipv4 outbound
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 100,
        traffic: AclTraffic.allTraffic(),
        direction: TrafficDirection.EGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv6 outbound
        cidr: AclCidr.anyIpv6(),
        ruleNumber: 101,
        traffic: AclTraffic.allTraffic(),
        direction: TrafficDirection.EGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv4 https
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 100,
        traffic: AclTraffic.tcpPort(443),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv6 https
        cidr: AclCidr.anyIpv6(),
        ruleNumber: 101,
        traffic: AclTraffic.tcpPort(443),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv4 http
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 102,
        traffic: AclTraffic.tcpPort(80),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv6 http
        cidr: AclCidr.anyIpv6(),
        ruleNumber: 103,
        traffic: AclTraffic.tcpPort(80),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv4 ephemeral tcp
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 998,
        traffic: AclTraffic.tcpPortRange(32768, 65535),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv6 ephemeral tcp
        cidr: AclCidr.anyIpv6(),
        ruleNumber: 999,
        traffic: AclTraffic.tcpPortRange(32768, 65535),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv4 ephemeral udp
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 1000,
        traffic: AclTraffic.udpPortRange(32768, 65535),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
    {// ipv6 ephemeral udp
        cidr: AclCidr.anyIpv4(),
        ruleNumber: 1001,
        traffic: AclTraffic.udpPortRange(32768, 65535),
        direction: TrafficDirection.INGRESS,
        ruleAction: Action.ALLOW
    },
]

export class MiwkeyNetworkStack extends Stack {
    public readonly miwkeyMainVpc: Vpc
    public readonly miwkeyDefaultSG: SecurityGroup
    public readonly miwkeyLoadBalancerSG: SecurityGroup
    public readonly miwkeyMainSubnets: Subnet[]
    public readonly miwkeyDomainCertificate: ICertificate

    constructor(scope: Construct, id: string, props: MiwkeyNetworkStackProps) {
        super(scope, id, props);

        this.miwkeyMainVpc = new aws_ec2.Vpc(this, "miwkeyMainVPC", {
                ipAddresses: aws_ec2.IpAddresses.cidr(props.ipAddresses.vpcCIDR),
                enableDnsHostnames: true,
                enableDnsSupport: true,
                natGateways: 0,
                vpcName: "miwkey-main",
                subnetConfiguration: [],
            }
        )
        this.miwkeyMainVpc.applyRemovalPolicy(RemovalPolicy.RETAIN)
        this.miwkeyMainSubnets = props.ipAddresses.subnetCIDRs.map((s, index) => {
            return new Subnet(this, `miwkey-subnet-${index}`, {
                availabilityZone: s.region,
                cidrBlock: s.ip,
                vpcId: this.miwkeyMainVpc.vpcId,
                mapPublicIpOnLaunch: true // public subnet扱いにさせるため必要
            })
        })

        const miwkeyMainIGW = new CfnInternetGateway(this, "igw-main")
        miwkeyMainIGW.applyRemovalPolicy(RemovalPolicy.RETAIN)
        const miwkeyNetworkAcl = new NetworkAcl(this, "miwkey-net-acl", {
            vpc: this.miwkeyMainVpc
        })
        const netAclList: CommonNetworkAclEntryOptions[] = basicNetAclList.concat([
            {// inside vpc
                cidr: AclCidr.ipv4(props.ipAddresses.vpcCIDR),
                ruleNumber: 1,
                traffic: AclTraffic.allTraffic(),
                direction: TrafficDirection.INGRESS,
                ruleAction: Action.ALLOW
            },
        ])
        if (props.ipAddresses.peerDestCIDR !== undefined) {
            netAclList.push({
                cidr: AclCidr.ipv4(props.ipAddresses.peerDestCIDR),
                ruleNumber: 2,
                traffic: AclTraffic.allTraffic(),
                direction: TrafficDirection.INGRESS,
                ruleAction: Action.ALLOW
            })
        }
        netAclList.forEach(
            a => miwkeyNetworkAcl.addEntry(`miwkey-${a.ruleNumber}-${a.direction ?? ""}`, a)
        )
        this.miwkeyMainSubnets.forEach(subnet => {
            subnet.applyRemovalPolicy(RemovalPolicy.RETAIN)
            subnet.addDefaultInternetRoute(miwkeyMainIGW.attrInternetGatewayId, miwkeyMainIGW)
            subnet.associateNetworkAcl(`net-acl-${subnet.toString()}`, miwkeyNetworkAcl)
        })

        this.miwkeyDefaultSG = new SecurityGroup(this, "miwkeyDefaultSG", {
            vpc: this.miwkeyMainVpc,
            allowAllOutbound: true
        })
        this.miwkeyDefaultSG.addIngressRule(
            Peer.ipv4(this.miwkeyMainVpc.vpcCidrBlock),
            Port.allTraffic(),
            "inside vpc"
        )

        if (props.ipAddresses.peerVpcId !== undefined && props.ipAddresses.peerDestCIDR !== undefined) {
            const SubVpcToMainVpcPeer = new CfnVPCPeeringConnection(this, "pcx-main-sub", {
                peerVpcId: props.ipAddresses.peerVpcId,
                vpcId: this.miwkeyMainVpc.vpcId
            })
            SubVpcToMainVpcPeer.applyRemovalPolicy(RemovalPolicy.RETAIN)
            this.miwkeyMainSubnets.forEach(subnet => {
                subnet.addRoute("sub_vpc_peer", {
                    routerId: SubVpcToMainVpcPeer.attrId,
                    routerType: RouterType.VPC_PEERING_CONNECTION,
                    destinationCidrBlock: props.ipAddresses.peerDestCIDR
                })
            })
            this.miwkeyDefaultSG.addIngressRule(
                Peer.ipv4(props.ipAddresses.peerDestCIDR),
                Port.allTraffic()
            )
        }

        this.miwkeyLoadBalancerSG = new SecurityGroup(this, "miwkeyLoadBalancerSG", {
            vpc: this.miwkeyMainVpc,
            allowAllOutbound: true
        })
        OnlyCloudflareIngressRules.forEach(rule => {
            this.miwkeyLoadBalancerSG.addIngressRule(
                rule.peer,
                rule.connection
            )
        })


        this.miwkeyDomainCertificate = Certificate.fromCertificateArn(this, "miwkeyDomainCertificate", props.certificateArn)
    }
}
