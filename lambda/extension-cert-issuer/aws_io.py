"""AWS boundary; no secret or response bodies are written to logs."""
import asyncio
import json
import re
import uuid
from datetime import datetime, timezone
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from certificate import metadata
from dns01 import Cloudflare
from acme_issue import bootstrap_account, restore, issue
from workflow import DeploymentRejected


class AwsIO:
    def __init__(self, config):
        self.config = config
        sdk = Config(connect_timeout=5, read_timeout=15, retries={'max_attempts': 2, 'mode': 'standard'})
        self.clients = {name: boto3.client(name, config=sdk) for name in ('secretsmanager', 'ssm', 'ecs', 'logs', 'cloudformation', 'cloudwatch')}
        self.update_client = boto3.client('ecs', config=Config(connect_timeout=5, read_timeout=15,
            retries={'total_max_attempts': 1, 'mode': 'standard'}))
        self.staging = False

    def secret_name(self, kind, staging=False):
        key = ('STAGING_' if staging else '') + kind + '_SECRET'
        if not self.config.get(key): raise ValueError('staging is not enabled')
        return self.config[key]

    def read_secret(self, name, optional=False, **version):
        try: return self.clients['secretsmanager'].get_secret_value(SecretId=name, **version)
        except ClientError as error:
            if optional and error.response['Error']['Code'] == 'ResourceNotFoundException': return None
            raise

    def token(self):
        token = self.read_secret(self.config['TOKEN_SECRET'], VersionStage='AWSCURRENT')['SecretString']
        if not token or '\n' in token: raise ValueError('invalid Cloudflare token')
        self.api = Cloudflare(self.config['ZONE_ID'], token)
        self.api.check()
        return token

    def account(self, bootstrap, staging):
        name = self.secret_name('ACCOUNT', staging)
        value = self.read_secret(name, optional=True, VersionStage='AWSCURRENT')
        if value:
            self.account_state = value['SecretString']
            restore(self.account_state, staging, self.api)
        elif bootstrap:
            self.account_state = asyncio.run(bootstrap_account(staging, self.api, self.config['ACCOUNT_EMAIL']))
            self.clients['secretsmanager'].put_secret_value(SecretId=name, SecretString=self.account_state, ClientRequestToken=str(uuid.uuid4()))
        else:
            raise ValueError('ACME account needs explicit bootstrap')

    def current(self, staging=False):
        self.staging = staging
        value = self.read_secret(self.secret_name('CERT', staging), optional=True, VersionStage='AWSCURRENT')
        if not value: return None
        payload = json.loads(value['SecretString'])
        return {'version': value['VersionId'], 'value': payload, 'meta': metadata(payload)}

    def issue(self, token, bootstrap, staging):
        return asyncio.run(issue(self.account_state, staging, self.api, self.config['FQDN']))

    def put_candidate(self, value, current, staging):
        args = {'SecretId': self.secret_name('CERT', staging), 'SecretString': json.dumps(value), 'ClientRequestToken': str(uuid.uuid4())}
        if current: args['VersionStages'] = ['AWSPENDING']
        return self.clients['secretsmanager'].put_secret_value(**args)['VersionId']

    def read_candidate(self, version, staging):
        return json.loads(self.read_secret(self.secret_name('CERT', staging), VersionId=version, VersionStage='AWSPENDING')['SecretString'])

    def promote(self, version, old):
        self.clients['secretsmanager'].update_secret_version_stage(SecretId=self.secret_name('CERT', self.staging),
            VersionStage='AWSCURRENT', MoveToVersionId=version, RemoveFromVersionId=old)
        self.clients['secretsmanager'].update_secret_version_stage(SecretId=self.secret_name('CERT', self.staging),
            VersionStage='AWSPENDING', RemoveFromVersionId=version)

    def load_state(self):
        try: return json.loads(self.clients['ssm'].get_parameter(Name=self.config['STATE_PARAMETER'])['Parameter']['Value'])
        except ClientError as error:
            if error.response['Error']['Code'] == 'ParameterNotFound': return {}
            raise

    def save_state(self, state):
        self.clients['ssm'].put_parameter(Name=self.config['STATE_PARAMETER'], Value=json.dumps(state), Type='String', Overwrite=True)
        pending = state.get('pending') or {}
        print(json.dumps({'event': 'deployment-state', 'result': state.get('result'),
                          'currentVersionId': state.get('current'), 'deployedVersionId': state.get('deployed'),
                          'requestedVersionId': pending.get('version'), 'deploymentId': pending.get('deploymentId')}))

    def observe(self):
        ecs = self.clients['ecs']
        stack = self.clients['cloudformation'].describe_stacks(StackName=self.config['STACK'])['Stacks'][0]['StackStatus']
        response = ecs.describe_services(cluster=self.config['CLUSTER'], services=[self.config['SERVICE']])
        if response.get('failures') or len(response.get('services', [])) != 1: raise ValueError('extension service unavailable')
        service = response['services'][0]
        arns = []
        for page in ecs.get_paginator('list_tasks').paginate(cluster=self.config['CLUSTER'], serviceName=self.config['SERVICE'], desiredStatus='RUNNING'):
            arns.extend(page.get('taskArns', []))
        tasks = []
        for start in range(0, len(arns), 100):
            response = ecs.describe_tasks(cluster=self.config['CLUSTER'], tasks=arns[start:start + 100])
            if response.get('failures'): raise ValueError('task inventory incomplete')
            tasks.extend(t for t in response['tasks'] if t['lastStatus'] == 'RUNNING')
        records = []
        # Task-specific stream avoids scanning six months of logs or trusting other tasks' entries.
        for task in tasks:
            task_id = task['taskArn'].rsplit('/', 1)[-1]
            pages = self.clients['logs'].get_paginator('filter_log_events').paginate(
                logGroupName='/ecs/miwkey-extension/app', logStreamNames=['app/app/' + task_id],
                filterPattern='"tls certificate loaded"')
            try:
                for page in pages:
                    for event in page.get('events', []):
                        try:
                            line = json.loads(event['message'])
                            fingerprint = line.get('certFingerprintSha256', '')
                            if line.get('msg') != 'tls certificate loaded' or line.get('taskArn') != task['taskArn'] or not re.fullmatch('[a-f0-9]{64}', fingerprint): continue
                            not_after = line['certNotAfter']
                            datetime.fromisoformat(not_after.replace('Z', '+00:00'))
                            if not isinstance(line['secretVersionId'], str): continue
                            records.append({'taskArn': line['taskArn'], 'versionId': line['secretVersionId'], 'fingerprint': fingerprint, 'notAfter': not_after})
                        except (ValueError, KeyError, TypeError):
                            continue
            except ClientError as error:
                if error.response['Error']['Code'] != 'ResourceNotFoundException': raise
        return stack, service['deployments'], tasks, records, service['desiredCount']

    def deploy(self):
        try:
            response = self.update_client.update_service(cluster=self.config['CLUSTER'], service=self.config['SERVICE'], forceNewDeployment=True)
        except ClientError as error:
            code = error.response['Error']['Code']
            if code in ('AccessDeniedException', 'InvalidParameterException', 'ClientException',
                        'ServiceNotActiveException', 'ClusterNotFoundException', 'ServiceNotFoundException', 'ThrottlingException'):
                raise DeploymentRejected() from None
            raise
        return next(d['id'] for d in response['service']['deployments'] if d['status'] == 'PRIMARY')

    def metrics(self, data):
        self.clients['cloudwatch'].put_metric_data(Namespace='Miwkey/ExtensionCertificate',
            MetricData=[{'MetricName': key, 'Value': value} for key, value in data.items()])
