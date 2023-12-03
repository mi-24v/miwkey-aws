import {StackProps} from "aws-cdk-lib";
import {Instance, SecurityGroup, Subnet, SubnetSelection, Vpc} from "aws-cdk-lib/aws-ec2";
import {ICertificate} from "aws-cdk-lib/aws-certificatemanager";
import {MiwkeyIp} from "./miwkey-ip";


export interface MiwkeyPublicStackProps extends StackProps{
    mainVpc: Vpc,
    mainSubnets: Subnet[]
    defaultSG: SecurityGroup,
    loadBalancerSG: SecurityGroup,
    domainCertificate: ICertificate,
    meilisearchInstance?: MiwkeyMeilisearchInstanceProps | undefined
}

export interface MiwkeyNetworkStackProps extends StackProps{
    ipAddresses: MiwkeyIp,
    certificateArn: string
}

export interface MiwkeyMeilisearchProps extends StackProps{
    targetFQDN: string
}
export type MiwkeyMeilisearchInstanceProps = {
    meilisearchInstance: Instance
} & MiwkeyMeilisearchProps

export interface MeilisearchInstanceProps extends StackProps {
    instanceVpc: Vpc,
    instanceSubnets: SubnetSelection,
    instanceSecurityGroup: SecurityGroup
}
