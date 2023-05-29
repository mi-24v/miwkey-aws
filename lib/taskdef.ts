import {ApplicationLoadBalancedTaskImageOptions} from "aws-cdk-lib/aws-ecs-patterns";
import {ContainerDefinitionOptions, ContainerImage, LogDriver, MountPoint} from "aws-cdk-lib/aws-ecs";
import {RetentionDays} from "aws-cdk-lib/aws-logs";


const imageTag = "4d04a48b-arm64"
const imageRepoUrl = "docker.io/miwpayou0808/misskey"

export function miwkeyMainTaskDefinition(): ApplicationLoadBalancedTaskImageOptions {
    return {
        image: ContainerImage.fromRegistry(`${imageRepoUrl}:${imageTag}`),
        command: ["npm", "run", "start"],
        containerPort: 8080,
        enableLogging: true
    }
}

export function miwkeyMigrationTaskDefinition(): ContainerDefinitionOptions {
    return {
        image: ContainerImage.fromRegistry(`${imageRepoUrl}:${imageTag}`),
        command: ["npm", "run", "migrate"],
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
