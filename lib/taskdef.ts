import {ApplicationLoadBalancedTaskImageOptions} from "aws-cdk-lib/aws-ecs-patterns";
import {ContainerDefinitionOptions, ContainerImage, LogDriver, MountPoint} from "aws-cdk-lib/aws-ecs";
import {RetentionDays} from "aws-cdk-lib/aws-logs";


const imageTag = "4d04a48b-arm64"
const imageRepoUrl = "docker.io/miwpayou0808/misskey"
const environmentVariables = {
    NODE_EXTRA_CA_CERTS: "/misskey/.config/ap-northeast-1-bundle.pem"
}

export function miwkeyMainTaskDefinition(): ApplicationLoadBalancedTaskImageOptions {
    return {
        image: ContainerImage.fromRegistry(`${imageRepoUrl}:${imageTag}`),
        command: ["npm", "run", "start"],
        containerPort: 8080,
        enableLogging: true,
        environment: environmentVariables,
        logDriver: LogDriver.awsLogs({
            streamPrefix: "miwkey",
            logRetention: RetentionDays.SIX_MONTHS
        })
    }
}

export function miwkeyMigrationTaskDefinition(): ContainerDefinitionOptions {
    return {
        image: ContainerImage.fromRegistry(`${imageRepoUrl}:${imageTag}`),
        command: ["npm", "run", "migrate"],
        environment: environmentVariables,
        essential: false,
        logging: LogDriver.awsLogs({
            streamPrefix: "miwkey",
            logRetention: RetentionDays.INFINITE
        }),
        memoryReservationMiB: 512,
        workingDirectory: "/misskey"
    }
}

export function miwkeyConfigMountPoint(volumeName: string): MountPoint{
    return {
        containerPath: "/misskey/.config",
        readOnly: true,
        sourceVolume: volumeName
    }
}
