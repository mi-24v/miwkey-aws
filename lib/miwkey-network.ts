import {aws_ec2, RemovalPolicy, Stack, StackProps} from "aws-cdk-lib";
import {Construct} from "constructs";
import {MiwkeyIp} from "./types/miwkey-ip";
import {CfnInternetGateway, CfnVPCPeeringConnection, RouterType, Subnet} from "aws-cdk-lib/aws-ec2";


export class MiwkeyNetworkStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const ipAddress: MiwkeyIp = require("./config/ipAddress.json")
        const miwkeyMainVpc = new aws_ec2.Vpc(this, "miwkeyMainVPC", {
                ipAddresses: aws_ec2.IpAddresses.cidr(ipAddress.vpcCIDR),
                enableDnsHostnames: false,
                enableDnsSupport: true,
                natGateways: 0,
                vpcName: "miwkey-main",
                subnetConfiguration: [],
            }
        )
        miwkeyMainVpc.applyRemovalPolicy(RemovalPolicy.RETAIN)
        const miwkeyMainSubnets: readonly Subnet[] = ipAddress.subnetCIDRs.map((s, index) => {
            return new Subnet(this, `miwkey-subnet-${index}`, {
                availabilityZone: s.region,
                cidrBlock: s.ip,
                vpcId: miwkeyMainVpc.vpcId
            })
        })

        const miwkeyMainIGW = new CfnInternetGateway(this, "igw-main")
        miwkeyMainIGW.applyRemovalPolicy(RemovalPolicy.RETAIN)
        if (ipAddress.peerVpcId !== undefined) {
            const SubVpcToMainVpcPeer = new CfnVPCPeeringConnection(this, "pcx-main-sub", {
                peerVpcId: ipAddress.peerVpcId,
                vpcId: miwkeyMainVpc.vpcId
            })
            SubVpcToMainVpcPeer.applyRemovalPolicy(RemovalPolicy.RETAIN)
            miwkeyMainSubnets.forEach(subnet => {
                subnet.applyRemovalPolicy(RemovalPolicy.RETAIN)
                subnet.addDefaultInternetRoute(miwkeyMainIGW.attrInternetGatewayId, miwkeyMainIGW)
                subnet.addRoute("sub_vpc_peer", {
                    routerId: SubVpcToMainVpcPeer.attrId,
                    routerType: RouterType.VPC_PEERING_CONNECTION,
                    destinationCidrBlock: ipAddress.peerDestCIDR
                })
            })
        }
    }
}
