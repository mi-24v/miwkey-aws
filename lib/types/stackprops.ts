import {StackProps} from "aws-cdk-lib";
import {SecurityGroup, Subnet, Vpc} from "aws-cdk-lib/aws-ec2";


export interface MiwkeyPublicStackProps extends StackProps{
    mainVpc: Vpc,
    mainSubnets: Subnet[]
    defaultSG: SecurityGroup
}
