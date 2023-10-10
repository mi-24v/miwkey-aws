import {MiwkeyNetworkStackProps} from "../types/stackprops";
import * as fs from "fs";
import {z} from "zod";
import {MiwkeyIp} from "../types/miwkey-ip";
import * as path from "path";
import {Environment} from "aws-cdk-lib";


export function loadNetworkProps(): MiwkeyNetworkStackProps {
    const ipConfSchema = z.object({
        vpcCIDR: z.string(),
        subnetCIDRs: z.array(z.object({
            region: z.string(),
            ip: z.string()
        })),
        peerVpcId: z.string().optional(),
        peerDestCIDR: z.string().optional()
    })
    const netPropsSchema = z.object({
        certificateArn: z.string().regex(/^arn:aws:(.+):(.+):(\d+):(.+)[:\/](.+)$/g)
    })
    const rawIpConf = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "ipAddress.json"), {encoding: "utf-8"}))
    const rawNetProps = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "networkprops.json"), {encoding: "utf-8"}))
    return {
        ipAddresses: ipConfSchema.parse(rawIpConf) as MiwkeyIp,
        certificateArn: netPropsSchema.parse(rawNetProps).certificateArn
    }
}

export function loadEnvironment() {
    const environmentSchema = z.object({
        account: z.string().regex(/^\d{12}/g),
        region: z.string()
    })
    const rawEnv = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "environment.json"), {encoding: "utf-8"}))
    return environmentSchema.parse(rawEnv) as Environment
}
