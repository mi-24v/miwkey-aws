import {IPeer, Peer, Port} from "aws-cdk-lib/aws-ec2";

interface SecurityGroupRule {
    peer: IPeer,
    connection: Port,
    description?: string | undefined,
    remoteRule?: boolean | undefined
}

export const OnlyCloudflareIngressRules: SecurityGroupRule[] = createCloudflareIngressRules()

function createCloudflareIngressRules(): SecurityGroupRule[] {
    // https://www.cloudflare.com/ips-v4
    const cloudflareIpv4: SecurityGroupRule[] = [
        "173.245.48.0/20",
        "103.21.244.0/22",
        "103.22.200.0/22",
        "103.31.4.0/22",
        "141.101.64.0/18",
        "108.162.192.0/18",
        "190.93.240.0/20",
        "188.114.96.0/20",
        "197.234.240.0/22",
        "198.41.128.0/17",
        "162.158.0.0/15",
        "104.16.0.0/13",
        "104.24.0.0/14",
        "172.64.0.0/13",
        "131.0.72.0/22",
    ].map(ip => {
        return {
            peer: Peer.ipv4(ip),
            connection: Port.tcp(443)
        }
    })

    // https://www.cloudflare.com/ips-v6
    const cloudflareIpv6: SecurityGroupRule[] = [
        "2400:cb00::/32",
        "2606:4700::/32",
        "2803:f800::/32",
        "2405:b500::/32",
        "2405:8100::/32",
        "2a06:98c0::/29",
        "2c0f:f248::/32",
    ].map(ip => {
        return {
            peer: Peer.ipv6(ip),
            connection: Port.tcp(443)
        }
    })

    return cloudflareIpv4.concat(cloudflareIpv6)
}
