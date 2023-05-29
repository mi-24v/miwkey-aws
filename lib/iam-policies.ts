import {AnyPrincipal, Effect, PolicyDocument, PolicyStatement, ServicePrincipal} from "aws-cdk-lib/aws-iam";

export const configFSPolicy: PolicyDocument = new PolicyDocument({
    assignSids: false,
    minimize: false,
    statements: [
        new PolicyStatement({
            effect: Effect.ALLOW,
            principals: [
                new ServicePrincipal("ecs.amazonaws.com"),
                new ServicePrincipal("ec2.amazonaws.com")
            ],
            actions: [
                "elasticfilesystem:ClientMount",
                "elasticfilesystem:ClientRootAccess",
                "elasticfilesystem:ClientWrite"
            ]
            // resources は自動指定させる(FSのARNそのものが必要なため
        }),
        new PolicyStatement({
            effect: Effect.DENY,
            principals: [new AnyPrincipal()],
            actions: ["*"],
            resources: ["*"],
            conditions: {
                Bool: {"aws:SecureTransport": "false"}
            }
        })
    ]
})

export function miwkeyECSTaskRolePolicy(taskEFSArn: string): PolicyStatement {
    return new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
            "elasticfilesystem:ClientMount",
            "elasticfilesystem:ClientRootAccess"
        ],
        resources: [taskEFSArn]
    })
}
