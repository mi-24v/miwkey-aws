import {Construct} from 'constructs';
import {ArnFormat, Duration, IgnoreMode, RemovalPolicy, Stack} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import {Topic} from 'aws-cdk-lib/aws-sns';
import {CfnSecret} from 'aws-cdk-lib/aws-secretsmanager';
import {Cluster} from 'aws-cdk-lib/aws-ecs';
import {ExtensionProps} from './config/loader';
import * as path from 'path';
import {readFileSync} from 'fs';
import {Platform} from 'aws-cdk-lib/aws-ecr-assets';

export function emptySecret(scope: Construct, id: string, retain = true): CfnSecret {
    const secret = new CfnSecret(scope, id, {});
    secret.applyRemovalPolicy(retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
    return secret;
}

export class ExtensionCertIssuer extends Construct {
    readonly fn: lambda.DockerImageFunction;
    constructor(scope: Construct, id: string, config: ExtensionProps, cluster: Cluster,
                certificate: CfnSecret, token: CfnSecret, account: CfnSecret, topic: Topic) {
        super(scope, id);
        const stack = Stack.of(this);
        const serviceArn = stack.formatArn({service: 'ecs', resource: 'service',
            resourceName: `${cluster.clusterName}/${config.serviceName}`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME});
        const stateName = `/miwkey/extension/${config.serviceName}/certificate-state`;
        const role = new iam.Role(this, 'Role', {assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')});
        const logGroup = new logs.LogGroup(this, 'Logs', {retention: logs.RetentionDays.SIX_MONTHS});
        const stagingCertificate = config.staging ? emptySecret(this, 'StagingCertificate', false) : undefined;
        const stagingAccount = config.staging ? emptySecret(this, 'StagingAccount', false) : undefined;
        const mutable = [certificate.ref, account.ref, ...stagingCertificate ? [stagingCertificate.ref, stagingAccount!.ref] : []];
        const grant = (actions: string[], resources: string[], conditions?: {[key: string]: any}) =>
            role.addToPolicy(new iam.PolicyStatement({actions, resources, conditions}));
        grant(['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecretVersionStage'], mutable);
        grant(['secretsmanager:GetSecretValue'], [token.ref]);
        grant(['ecs:DescribeServices', 'ecs:UpdateService'], [serviceArn]);
        // ListTasks cannot be scoped to a service ARN; restrict inventory to this cluster.
        grant(['ecs:ListTasks'], ['*'], {ArnEquals: {'ecs:cluster': cluster.clusterArn}});
        grant(['ecs:DescribeTasks'], [stack.formatArn({service: 'ecs', resource: 'task', resourceName: `${cluster.clusterName}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME})],
            {ArnEquals: {'ecs:cluster': cluster.clusterArn}});
        grant(['cloudformation:DescribeStacks'], [stack.stackId]);
        grant(['ssm:GetParameter', 'ssm:PutParameter'], [stack.formatArn({service: 'ssm', resource: 'parameter', resourceName: stateName.slice(1), arnFormat: ArnFormat.SLASH_RESOURCE_NAME})]);
        grant(['logs:FilterLogEvents'], [stack.formatArn({service: 'logs', resource: 'log-group', resourceName: '/ecs/miwkey-extension/app:*', arnFormat: ArnFormat.COLON_RESOURCE_NAME})]);
        grant(['logs:CreateLogStream', 'logs:PutLogEvents'], [logGroup.logGroupArn]);
        grant(['cloudwatch:PutMetricData'], ['*'], {StringEquals: {'cloudwatch:namespace': 'Miwkey/ExtensionCertificate'}});
        this.fn = new lambda.DockerImageFunction(this, 'Function', {
            code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..'), {
                file: 'lambda/extension-cert-issuer/Dockerfile', platform: Platform.LINUX_AMD64,
                ignoreMode: IgnoreMode.DOCKER,
                exclude: readFileSync(path.join(__dirname, '../.dockerignore'), 'utf8').split('\n').filter(Boolean),
            }),
            architecture: lambda.Architecture.X86_64,
            role, logGroup, timeout: Duration.minutes(15), reservedConcurrentExecutions: 1,
            memorySize: 512, retryAttempts: 0, maxEventAge: Duration.seconds(60),
            environment: {
                FQDN: config.fqdn, ZONE_ID: config.cloudflareZoneId,
                CERT_SECRET: certificate.ref, TOKEN_SECRET: token.ref, ACCOUNT_SECRET: account.ref,
                CLUSTER: cluster.clusterName, SERVICE: config.serviceName, STACK: stack.stackName,
                STATE_PARAMETER: stateName, ACCOUNT_EMAIL: config.accountEmail,
                RENEWAL_DAYS: String(config.renewalDays),
                ...stagingCertificate ? {STAGING_CERT_SECRET: stagingCertificate.ref, STAGING_ACCOUNT_SECRET: stagingAccount!.ref} : {},
            },
        });
        const scheduleRole = new iam.Role(this, 'ScheduleRole', {assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com')});
        this.fn.grantInvoke(scheduleRole);
        new scheduler.CfnSchedule(this, 'Daily', {
            flexibleTimeWindow: {mode: 'OFF'}, scheduleExpression: 'rate(1 day)',
            state: config.stage === 'scheduled' ? 'ENABLED' : 'DISABLED',
            startDate: config.stage === 'scheduled' ? config.monitoringStart : undefined,
            target: {arn: this.fn.functionArn, roleArn: scheduleRole.roleArn, input: JSON.stringify({mode: 'scheduled'}),
                retryPolicy: {maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60}},
        });
        topic.addToResourcePolicy(new iam.PolicyStatement({principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
            actions: ['sns:Publish'], resources: [topic.topicArn], conditions: {StringEquals: {'aws:SourceAccount': stack.account},
                ArnLike: {'aws:SourceArn': stack.formatArn({service: 'cloudwatch', resource: 'alarm', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME})}}}));
        const metric = (name: string) => new cw.Metric({namespace: 'Miwkey/ExtensionCertificate', metricName: name, period: Duration.days(1), statistic: 'Minimum'});
        const alarm = (id: string, m: cw.IMetric, threshold: number, comparisonOperator: cw.ComparisonOperator, missing: cw.TreatMissingData) => {
            const a = new cw.Alarm(this, id, {metric: m, threshold, comparisonOperator, evaluationPeriods: 1, treatMissingData: missing,
                actionsEnabled: config.stage === 'scheduled'});
            a.addAlarmAction(new actions.SnsAction(topic));
        };
        alarm('ServingExpiry', metric('ServingDays'), config.warningDays, cw.ComparisonOperator.LESS_THAN_THRESHOLD, cw.TreatMissingData.BREACHING);
        if (config.stage === 'scheduled') {
            // A fresh alarm on each enable avoids a pre-existing, action-disabled ALARM.
            // The explicit activation epoch provides real initialization grace, not missing history.
            const graceEnd = Date.parse(config.monitoringStart!) / 1000 + 2 * 86400;
            const heartbeat = new cw.MathExpression({
                expression: `IF(EPOCH(TIME_SERIES(0)) < ${graceEnd}, 1, FILL(heartbeat, 0))`,
                usingMetrics: {heartbeat: metric('Heartbeat').with({statistic: 'Maximum'})},
                period: Duration.days(1),
            });
            const missing = new cw.Alarm(this, 'MissingTelemetry', {metric: heartbeat, threshold: 1,
                comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
                evaluationPeriods: 2, datapointsToAlarm: 2, actionsEnabled: true,
                treatMissingData: cw.TreatMissingData.BREACHING});
            missing.addAlarmAction(new actions.SnsAction(topic));
        }
        alarm('ApplyDelay', metric('ApplyDelayDays').with({statistic: 'Maximum'}), 2,
            cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, cw.TreatMissingData.NOT_BREACHING);
        for (const name of ['UnknownTasks', 'ApplyFailure', 'IssueFailure', 'TokenFailure', 'AccountFailure', 'ObserveFailure', 'ValidationFailure', 'StorageFailure', 'DeployRequestFailure']) {
            alarm(name, metric(name).with({statistic: 'Maximum'}), 0, cw.ComparisonOperator.GREATER_THAN_THRESHOLD, cw.TreatMissingData.NOT_BREACHING);
        }
        alarm('LambdaErrors', this.fn.metricErrors({period: Duration.days(1)}), 0, cw.ComparisonOperator.GREATER_THAN_THRESHOLD, cw.TreatMissingData.NOT_BREACHING);
    }
}
