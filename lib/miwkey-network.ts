import {aws_ec2, Fn, RemovalPolicy, Stack} from "aws-cdk-lib";
import {Construct} from "constructs";
import {
    AclCidr,
    AclTraffic,
    Action,
    CfnInternetGateway,
    CfnVPCPeeringConnection,
    CommonNetworkAclEntryOptions,
    IpProtocol,
    Ipv6Addresses,
    NetworkAcl,
    Peer,
    Port,
    RouterType,
    SecurityGroup,
    Subnet,
    SubnetType,
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
        const ipv6Addresses = Ipv6Addresses.amazonProvided();

        this.miwkeyMainVpc = new aws_ec2.Vpc(this, "miwkeyMainVPC", {
                ipAddresses: aws_ec2.IpAddresses.cidr(props.ipAddresses.vpcCIDR),
                ipProtocol: IpProtocol.DUAL_STACK,
                ipv6Addresses: ipv6Addresses,
                enableDnsHostnames: true,
                enableDnsSupport: true,
                natGateways: 0,
                vpcName: "miwkey-main",
                subnetConfiguration: [
                    // subnetConfiguration must contain elements for calling createSubnets
                    // https://github.com/aws/aws-cdk/blob/92b912d90cfaf9abc2878693224e9cd9d9e79fe4/packages/aws-cdk-lib/aws-ec2/lib/vpc.ts#L1605C8-L1605C68
                    {
                        name: "public-stub",
                        subnetType: SubnetType.PUBLIC,
                        cidrMask: 28,
                        ipv6AssignAddressOnCreation: true,
                        mapPublicIpOnLaunch: false
                    }
                ],
            }
        )
        this.miwkeyMainVpc.applyRemovalPolicy(RemovalPolicy.RETAIN)
        const ipv6CidrBlocks = ipv6Addresses.createIpv6CidrBlocks({
            ipv6SelectedCidr: this.miwkeyMainVpc.vpcCidrBlock,
            subnetCount: 3
        });
        this.miwkeyMainSubnets = props.ipAddresses.subnetCIDRs.map((s, index) => {
            return new Subnet(this, `miwkey-subnet-${index}`, {
                availabilityZone: s.region,
                cidrBlock: s.ip,
                vpcId: this.miwkeyMainVpc.vpcId,
                assignIpv6AddressOnCreation: true,
                ipv6CidrBlock: Fn.select(index, ipv6CidrBlocks),
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
            subnet.addIpv6DefaultInternetRoute(miwkeyMainIGW.attrInternetGatewayId)
            subnet.associateNetworkAcl(`net-acl-${subnet.toString()}`, miwkeyNetworkAcl)
        })

        this.miwkeyDefaultSG = new SecurityGroup(this, "miwkeyDefaultSG", {
            vpc: this.miwkeyMainVpc,
            allowAllOutbound: true,
            allowAllIpv6Outbound: true
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
            allowAllOutbound: true,
            allowAllIpv6Outbound: true
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
