import {StackProps} from "aws-cdk-lib";
import {SecurityGroup, Subnet, Vpc} from "aws-cdk-lib/aws-ec2";
import {ICertificate} from "aws-cdk-lib/aws-certificatemanager";
import {MiwkeyIp} from "./miwkey-ip";


export interface MiwkeyPublicStackProps extends StackProps{
    mainVpc: Vpc,
    mainSubnets: Subnet[]
    defaultSG: SecurityGroup
    domainCertificate: ICertificate
}

export interface MiwkeyNetworkStackProps extends StackProps{
    ipAddresses: MiwkeyIp,
    certificateArn: string
}
