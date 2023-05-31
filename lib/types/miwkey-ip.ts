export interface MiwkeyIp {
    vpcCIDR: string
    subnetCIDRs: subnetInfo[]
    peerVpcId: string | undefined
    peerDestCIDR: string | undefined
}

export type subnetInfo = {
    readonly region: string
    readonly ip: string
}
