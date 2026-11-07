from copy import deepcopy
import pytest
from workflow import Engine

META = {'fingerprint': 'a'*64, 'notAfter': '2027-01-15T00:00:00Z'}
class MemoryIO:
    def __init__(self):
        self.cert = {'version': 'v1', 'value': {'candidate': 1}, 'meta': META}
        self.state = {'deployed': 'v1'}
        self.writes = []; self.requests = []; self.issued = 0
        self.status = 'UPDATE_COMPLETE'; self.deployments = [{'id': 'old', 'rolloutState': 'COMPLETED'}]
        self.logs = [{'taskArn': 't1', 'versionId': 'v1', **META}]
        self.tasks = [{'taskArn': 't1', 'startedBy': 'old'}]
        self.token_reads = 0; self.bad_token = False
    def token(self):
        self.token_reads += 1
        if self.bad_token: raise ValueError('token rejected')
        return 'token'
    def account(self, bootstrap, staging): return None
    def current(self, staging=False): return deepcopy(self.cert)
    def load_state(self): return deepcopy(self.state)
    def save_state(self, state): self.state = deepcopy(state)
    def observe(self): return self.status, self.deployments, self.tasks, self.logs, 1
    def issue(self, token, bootstrap, staging):
        self.issued += 1
        return {'candidate': 2}
    def put_candidate(self, value, current, staging):
        self.writes.append('put'); self.pending = value
        if not current: self.cert = {'version': 'v2', 'value': value, 'meta': META}
        return 'v2'
    def read_candidate(self, version, staging): return self.pending
    def promote(self, version, old):
        self.writes.append('promote'); self.cert = {'version': version, 'value': self.pending, 'meta': META}
    def deploy(self):
        self.requests.append({'forceNewDeployment': True}); return 'ecs-new'
    def metrics(self, data): self.telemetry = data


def make(io, valid=True):
    def check(value, staging):
        if not valid: raise ValueError('invalid candidate')
        return META
    return Engine(io, check, now=1792195200, renewal_days=30)

def test_no_renewal_or_deployment_on_ordinary_day():
    io = MemoryIO(); make(io).run('scheduled')
    assert io.issued == 0 and io.requests == [] and io.writes == []
    assert io.telemetry['ServingDays'] == 90
    assert io.token_reads == 1

@pytest.mark.parametrize('status', ['UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS'])
def test_promoted_version_retries_deploy_only_after_stack_stable(status):
    io = MemoryIO(); io.state = {'deployed': 'old'}; io.status = status
    io.logs[0]['versionId'] = 'old'
    make(io).run('scheduled'); assert io.requests == [] and io.issued == 0
    assert io.state['current'] == 'v1'
    io.status = 'UPDATE_COMPLETE'; make(io).run('scheduled')
    assert len(io.requests) == 1 and io.issued == 0
    assert io.state['pending']['deploymentId'] == 'ecs-new'
    assert io.telemetry['ApplyFailure'] == 0

@pytest.mark.parametrize('initial', [True, False])
def test_invalid_candidate_is_never_written_or_promoted(initial):
    io = MemoryIO()
    if initial: io.cert = None
    with pytest.raises(ValueError): make(io, valid=False).run('bootstrap', force=True)
    assert io.writes == [] and io.requests == []

def test_bootstrap_never_deploys():
    io = MemoryIO(); io.cert = None
    make(io).run('bootstrap')
    assert io.writes == ['put'] and io.requests == []

def test_renewal_reads_back_before_promotion_and_tracks_requested_deployment():
    io = MemoryIO(); make(io).run('scheduled', force=True)
    assert io.writes == ['put', 'promote']
    assert io.requests == [{'forceNewDeployment': True}]
    assert io.state['deployed'] == 'v1' and io.state['pending']['version'] == 'v2'

def test_completed_rollout_requires_all_matching_startup_logs():
    io = MemoryIO(); io.cert['version'] = 'v2'
    io.state['pending'] = {'version': 'v2', 'deploymentId': 'ecs-new', 'meta': META}
    io.deployments = [{'id': 'ecs-new', 'rolloutState': 'COMPLETED'}]
    io.tasks = [{'taskArn': 't1', 'startedBy': 'ecs-new'}]; io.logs = []
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v1' and io.telemetry['UnknownTasks'] == 1
    io.logs = [{'taskArn': 't1', 'versionId': 'v2', **META}]
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v2' and io.state.get('pending') is None
    assert io.issued == 0

def test_failed_rollout_is_not_marked_successful_or_automatically_reissued():
    io = MemoryIO(); io.state['pending'] = {'version': 'v1', 'deploymentId': 'failed', 'meta': META}
    io.deployments = [{'id': 'failed', 'rolloutState': 'FAILED'}]
    make(io).run('scheduled')
    assert io.telemetry['ApplyFailure'] == 1 and io.issued == 0 and io.requests == []

def test_invalid_token_leaves_current_untouched():
    io = MemoryIO(); io.bad_token = True
    with pytest.raises(ValueError): make(io).run('scheduled', force=True)
    assert io.writes == []
    assert io.cert['version'] == 'v1'

def test_staging_is_manual_only_and_never_promotes_production():
    io = MemoryIO()
    with pytest.raises(ValueError): make(io).run('scheduled', staging=True)
    assert io.writes == []

def test_issuance_logs_only_version_and_public_certificate_metadata(capsys):
    io = MemoryIO(); io.cert = None
    make(io).run('bootstrap')
    import json
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    stored = next(event for event in events if event['event'] == 'certificate-stored')
    assert stored == {'event': 'certificate-stored', 'versionId': 'v2', **META}
    assert 'candidate' not in str(events)
