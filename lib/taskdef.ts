import {ApplicationLoadBalancedTaskImageOptions} from "aws-cdk-lib/aws-ecs-patterns";
import {ContainerDefinitionOptions, ContainerImage, MountPoint} from "aws-cdk-lib/aws-ecs";


const imageTag = "4d04a48b"
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
        memoryReservationMiB: 1024,
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
