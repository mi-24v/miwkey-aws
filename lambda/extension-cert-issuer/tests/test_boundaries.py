import asyncio
import json
from types import SimpleNamespace
import boto3
from botocore.stub import Stubber
import pytest
import acme_issue
import handler as entry
from aws_io import AwsIO
from test_certificate import bundle, FQDN, NOW
from certificate import production_validate, validate
from test_workflow import MemoryIO
from workflow import Engine


def io_with(client, service='secretsmanager'):
    io = object.__new__(AwsIO)
    io.config = {'CERT_SECRET': 'cert', 'STAGING_CERT_SECRET': 'stage-cert', 'CLUSTER': 'cluster', 'SERVICE': 'extension'}
    io.clients = {service: client}; io.update_client = client; io.staging = False
    return io


def client(name):
    return boto3.client(name, region_name='us-east-1', aws_access_key_id='fixture', aws_secret_access_key='fixture')


def test_pending_write_and_promotion_use_explicit_version_stages():
    sdk = client('secretsmanager'); io = io_with(sdk)
    version = 'a'*32; old = 'b'*32
    with Stubber(sdk) as stub:
        from botocore.stub import ANY
        stub.add_response('put_secret_value', {'VersionId': version}, {'SecretId': 'cert', 'SecretString': '{"certificatePem": "public", "privateKeyPem": "key"}', 'ClientRequestToken': ANY, 'VersionStages': ['AWSPENDING']})
        stub.add_response('get_secret_value', {'VersionId': version, 'SecretString': '{"certificatePem":"public","privateKeyPem":"key"}'}, {'SecretId': 'cert', 'VersionId': version, 'VersionStage': 'AWSPENDING'})
        stub.add_response('update_secret_version_stage', {}, {'SecretId': 'cert', 'VersionStage': 'AWSCURRENT', 'MoveToVersionId': version, 'RemoveFromVersionId': old})
        stub.add_response('update_secret_version_stage', {}, {'SecretId': 'cert', 'VersionStage': 'AWSPENDING', 'RemoveFromVersionId': version})
        payload = {'certificatePem': 'public', 'privateKeyPem': 'key'}
        assert io.put_candidate(payload, {'version': old}, False) == version
        assert io.read_candidate(version, False) == payload
        io.promote(version, old)
        stub.assert_no_pending_responses()


def test_ecs_update_sends_no_task_definition_or_other_mutating_parameters():
    sdk = client('ecs'); io = io_with(sdk, 'ecs')
    with Stubber(sdk) as stub:
        stub.add_response('update_service', {'service': {'deployments': [{'id': 'ecs-new', 'status': 'PRIMARY'}]}}, {'cluster': 'cluster', 'service': 'extension', 'forceNewDeployment': True})
        assert io.deploy() == 'ecs-new'
        stub.assert_no_pending_responses()


def test_staging_certificate_storage_cannot_select_production_secret():
    sdk = client('secretsmanager'); io = io_with(sdk)
    from botocore.stub import ANY
    with Stubber(sdk) as stub:
        stub.add_response('put_secret_value', {'VersionId': 'a'*32}, {'SecretId': 'stage-cert', 'SecretString': '{}', 'ClientRequestToken': ANY})
        io.put_candidate({}, None, True)
        stub.assert_no_pending_responses()


def test_account_directory_and_url_cannot_cross_environments():
    for staging in (True, False):
        wrong = json.dumps({'directory': acme_issue.DIRECTORIES[not staging], 'account_url': 'https://acme-v02.api.letsencrypt.org/acme/acct/1'})
        with pytest.raises(ValueError): acme_issue.restore(wrong, staging, None)


def test_missing_account_never_registers_automatically_in_scheduled_mode(monkeypatch):
    io = io_with(client('secretsmanager')); io.config['ACCOUNT_SECRET'] = 'account'
    io.read_secret = lambda *args, **kwargs: None
    async def forbidden(*args): raise AssertionError('registration attempted')
    monkeypatch.setattr(acme_issue, 'bootstrap_account', forbidden)
    with pytest.raises(ValueError, match='explicit bootstrap'): io.account(False, False)


def test_sdk_error_body_is_absent_from_lambda_logs_and_response(monkeypatch, capsys):
    class Broken:
        def __init__(self, config): raise ValueError('PRIVATE KEY JWT TOKEN PAYLOAD')
    monkeypatch.setattr(entry, 'AwsIO', Broken)
    with pytest.raises(RuntimeError) as error: entry.handler({'mode': 'bootstrap'}, None)
    assert not any(s in str(error.value) + capsys.readouterr().out for s in ('PRIVATE KEY', 'JWT', 'TOKEN', 'PAYLOAD'))
    assert error.value.__suppress_context__


def test_real_certificate_rejection_happens_before_any_secret_write():
    io = MemoryIO(); io.cert = None
    value, roots = bundle(name='wrong.example.com'); io.issue = lambda *args: value
    with pytest.raises(ValueError):
        Engine(io, lambda v, staging: validate(v, FQDN, roots, NOW)).run('bootstrap')
    assert io.writes == []


def test_readback_tampering_does_not_promote():
    io = MemoryIO()
    io.read_candidate = lambda *args: {'candidate': 'tampered'}
    def validator(value, staging):
        if value.get('candidate') == 'tampered': raise ValueError('invalid readback')
        return {'fingerprint': 'a'*64, 'notAfter': '2027-01-15T00:00:00Z'}
    with pytest.raises(ValueError): Engine(io, validator).run('bootstrap', force=True)
    assert io.writes == ['put']
    assert io.cert['version'] == 'v1'

def test_dependency_child_loggers_cannot_propagate_response_bodies():
    import subprocess
    import sys
    from pathlib import Path
    script = "import handler, logging; logging.basicConfig(level=logging.DEBUG); logging.getLogger('botocore.httpsession').error('fixture-secret-body')"
    result = subprocess.run([sys.executable, '-c', script], cwd=Path(entry.__file__).parent, capture_output=True, text=True)
    assert result.returncode == 0
    assert 'fixture-secret-body' not in result.stdout + result.stderr

@pytest.mark.parametrize('status,code', [(500, 'ServerException'), (400, 'ThrottlingException')])
def test_update_service_transmits_exactly_once_even_for_retryable_responses(monkeypatch, status, code):
    from botocore.awsrequest import AWSResponse
    import aws_io
    session = boto3.Session(region_name='us-east-1', aws_access_key_id='fixture', aws_secret_access_key='fixture')
    monkeypatch.setattr(aws_io.boto3, 'client', lambda name, config: session.client(name, config=config))
    io = AwsIO({'CLUSTER': 'cluster', 'SERVICE': 'extension'})
    sends = []
    class Body:
        def stream(self, **kwargs): yield json.dumps({'__type': code, 'message': 'fixture-private'}).encode()
    def send(request):
        sends.append(request)
        return AWSResponse(request.url, status, {'content-type': 'application/x-amz-json-1.1'}, Body())
    sdk = getattr(io, 'update_client', io.clients['ecs'])
    monkeypatch.setattr(sdk._endpoint.http_session, 'send', send)
    monkeypatch.setattr('time.sleep', lambda _: None)
    with pytest.raises(Exception): io.deploy()
    assert len(sends) == 1


def test_explicit_throttling_response_is_rejected_without_ambiguous_intent():
    from workflow import DeploymentRejected
    sdk = client('ecs'); io = io_with(sdk, 'ecs')
    with Stubber(sdk) as stub:
        stub.add_client_error('update_service', service_error_code='ThrottlingException', http_status_code=400,
                              expected_params={'cluster': 'cluster', 'service': 'extension', 'forceNewDeployment': True})
        with pytest.raises(DeploymentRejected): io.deploy()
        stub.assert_no_pending_responses()
