import {Construct} from 'constructs';
import {CfnOutput, RemovalPolicy, Stack, Duration} from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {HttpNamespace} from 'aws-cdk-lib/aws-servicediscovery';
import {Topic} from 'aws-cdk-lib/aws-sns';
import {ExtensionProps, parseExtensionProps} from './config/loader';
import {ExtensionCertIssuer, emptySecret} from './extension-cert-issuer';

export class NotificationExtension extends Construct {
    readonly jwt: secrets.Secret;
    readonly service?: ecs.Ec2Service;
    readonly namespace: HttpNamespace;
    private readonly clientProxyLogs: logs.LogGroup;
    constructor(scope: Construct, id: string, input: ExtensionProps, cluster: ecs.Cluster,
                capacityProvider: ecs.AsgCapacityProvider, topic: Topic) {
        super(scope, id);
        const config = parseExtensionProps(input);
        const table = new dynamodb.Table(this, 'Notifications', {
            partitionKey: {name: 'notifieeId', type: dynamodb.AttributeType.STRING},
            sortKey: {name: 'sortKey', type: dynamodb.AttributeType.STRING},
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: {pointInTimeRecoveryEnabled: true},
            removalPolicy: RemovalPolicy.RETAIN,
        });
        table.addGlobalSecondaryIndex({indexName: 'notificationId-index',
            partitionKey: {name: 'id', type: dynamodb.AttributeType.STRING}, projectionType: dynamodb.ProjectionType.ALL});
        this.jwt = new secrets.Secret(this, 'Jwt', {generateSecretString: {passwordLength: 64, excludePunctuation: true}, removalPolicy: RemovalPolicy.RETAIN});
        const certificate = emptySecret(this, 'Certificate');
        const account = emptySecret(this, 'AcmeAccount');
        const token = emptySecret(this, 'CloudflareToken');
        this.namespace = new HttpNamespace(this, 'Namespace', {name: config.namespace});
        const appLogs = new logs.LogGroup(this, 'AppLogs', {logGroupName: '/ecs/miwkey-extension/app', retention: logs.RetentionDays.SIX_MONTHS, removalPolicy: RemovalPolicy.RETAIN});
        const proxyLogs = new logs.LogGroup(this, 'ProxyLogs', {logGroupName: '/ecs/miwkey-extension/service-connect', retention: logs.RetentionDays.SIX_MONTHS, removalPolicy: RemovalPolicy.RETAIN});
        this.clientProxyLogs = new logs.LogGroup(this, 'ClientProxyLogs', {logGroupName: '/ecs/miwkey/service-connect', retention: logs.RetentionDays.SIX_MONTHS, removalPolicy: RemovalPolicy.RETAIN});
        const issuer = new ExtensionCertIssuer(this, 'Issuer', config, cluster, certificate, token, account, topic);
        if (config.stage !== 'bootstrap') {
            const task = new ecs.Ec2TaskDefinition(this, 'Task', {networkMode: ecs.NetworkMode.BRIDGE});
            const cfnTask = task.node.defaultChild as ecs.CfnTaskDefinition;
            cfnTask.cpu = String(config.budgets.extensionCpu);
            cfnTask.memory = String(config.budgets.extensionMemory);
            task.addContainer('app', {
                image: ecs.ContainerImage.fromRegistry(config.image), cpu: config.budgets.appCpu,
                memoryReservationMiB: config.budgets.appMemory,
                environment: {DYNAMODB_NOTIFICATION_TABLE: table.tableName, AWS_REGION: Stack.of(this).region,
                    TLS_CERT_SECRET_ARN: certificate.ref, TLS_SERVER_NAME: config.fqdn},
                secrets: {AUTH_SECRET: ecs.Secret.fromSecretsManager(this.jwt)},
                logging: ecs.LogDrivers.awsLogs({logGroup: appLogs, streamPrefix: 'app'}),
                healthCheck: {command: ['CMD', '/miwkey-extension', 'healthcheck'], startPeriod: Duration.seconds(60), interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3},
                portMappings: [{name: 'extension-tls', containerPort: 8080, hostPort: 0, protocol: ecs.Protocol.TCP}],
            });
            task.addToTaskRolePolicy(new iam.PolicyStatement({actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
                resources: [table.tableArn, `${table.tableArn}/index/notificationId-index`]}));
            task.addToTaskRolePolicy(new iam.PolicyStatement({actions: ['secretsmanager:GetSecretValue'], resources: [certificate.ref]}));
            this.service = new ecs.Ec2Service(this, 'Service', {
                cluster, taskDefinition: task, serviceName: config.serviceName, desiredCount: 2,
                minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: {rollback: true},
                capacityProviderStrategies: [{capacityProvider: capacityProvider.capacityProviderName, weight: 1}],
                placementConstraints: [ecs.PlacementConstraint.distinctInstances()],
                placementStrategies: [ecs.PlacementStrategy.packedByMemory()],
                serviceConnectConfiguration: {namespace: this.namespace.namespaceArn,
                    logDriver: ecs.LogDrivers.awsLogs({logGroup: proxyLogs, streamPrefix: 'proxy'}),
                    services: [{portMappingName: 'extension-tls', dnsName: config.fqdn, port: 8080}]},
            });
        }
        const outputs: {[key: string]: string} = {Cluster: cluster.clusterName, Service: config.serviceName,
            Namespace: this.namespace.namespaceName, Table: table.tableName, JwtSecret: this.jwt.secretArn,
            CertificateSecret: certificate.ref, AccountSecret: account.ref, CloudflareTokenSecret: token.ref,
            Fqdn: config.fqdn, ZoneId: config.cloudflareZoneId, IssuerArn: issuer.fn.functionArn, AlertTopicArn: topic.topicArn};
        for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, `${key}Output`, {value});
    }

    configureClient(task: ecs.Ec2TaskDefinition, service: ecs.Ec2Service, config: ExtensionProps) {
        const cfn = task.node.defaultChild as ecs.CfnTaskDefinition;
        cfn.cpu = String(config.budgets.mainCpu); cfn.memory = String(config.budgets.mainMemory);
        service.enableServiceConnect({namespace: this.namespace.namespaceArn,
            logDriver: ecs.LogDrivers.awsLogs({logGroup: this.clientProxyLogs, streamPrefix: 'proxy'})});
        task.defaultContainer!.addEnvironment('NOTIFICATION_EXTENSION_URL', `https://${config.fqdn}:8080`);
        task.defaultContainer!.addSecret('NOTIFICATION_EXTENSION_SECRET', ecs.Secret.fromSecretsManager(this.jwt));
        service.node.addDependency(this.service!);
    }
}
