"""Renewal availability must not depend on deployment evidence or capacity."""
from copy import deepcopy
import pytest
from test_workflow import MemoryIO, META, make
from test_recovery import pending


def due(kind):
    io = MemoryIO()
    io.cert['meta'] = {**META, 'notAfter': '2026-11-01T00:00:00Z'}
    if kind == 'unknown': io.logs = []
    if kind == 'capacity': io.tasks = []; io.logs = []
    if kind == 'mismatch': io.logs[0]['versionId'] = 'older'
    return io


@pytest.mark.parametrize('kind', ['unknown', 'capacity', 'mismatch'])
def test_due_certificate_is_promoted_despite_unresolved_tasks_without_daily_reissuance(kind):
    io = due(kind)
    make(io).run('scheduled')
    assert io.issued == 1 and io.writes == ['put', 'promote'] and io.cert['version'] == 'v2'
    assert io.state['deployed'] == 'v1'
    if kind != 'mismatch': assert io.requests == []
    engine = make(io); engine.now += 86400; engine.run('scheduled')
    assert io.issued == 1


@pytest.mark.parametrize('deployment', [None, 'gone', 'in-progress'])
def test_renewal_preserves_prior_uncertain_intent_until_proof_or_guarded_recovery(deployment):
    io = due('unknown'); pending(io, deployment)
    io.state['pending']['version'] = 'v1'
    if deployment == 'in-progress':
        io.deployments = [{'id': deployment, 'status': 'PRIMARY', 'rolloutState': 'IN_PROGRESS'}]
    original = deepcopy(io.state['pending'])
    make(io).run('scheduled')
    assert io.issued == 1 and io.cert['version'] == 'v2' and io.requests == []
    assert io.state['pending'] == original and io.state['deployed'] == 'v1'
    make(io).run('scheduled')
    assert io.issued == 1 and io.requests == []


def no_pending_event(io):
    return {'expectedVersionId': io.cert['version'], 'expectedStateToken': io.state['recoveryToken'],
            'expectedDeploymentId': 'old', 'quiescenceConfirmed': True}


def test_no_pending_unknown_recovery_has_persisted_token_and_rejects_replay():
    io = due('unknown'); make(io).run('scheduled')
    event = no_pending_event(io)
    assert event['expectedStateToken'] and event['expectedStateToken'] != 'None'
    make(io).run('scheduled')
    assert io.state['recoveryToken'] == event['expectedStateToken']
    make(io).run('reconcile', recovery=event)
    assert len(io.requests) == 1 and io.state['pending']['version'] == 'v2'
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert len(io.requests) == 1


@pytest.mark.parametrize('field,value', [('expectedVersionId', 'old'), ('expectedStateToken', 'stale'),
    ('expectedDeploymentId', 'replaced'), ('quiescenceConfirmed', False), ('quiescenceConfirmed', 1)])
def test_no_pending_recovery_checks_every_guard(field, value):
    io = due('unknown'); make(io).run('scheduled')
    event = {**no_pending_event(io), field: value}
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert io.requests == [] and io.telemetry['ObserveFailure'] == 0
    assert io.telemetry['ApplyFailure'] == 1


def test_no_pending_recovery_requires_unresolved_state_and_stable_primary():
    io = MemoryIO()
    event = {'expectedVersionId': 'v1', 'expectedStateToken': 'None',
             'expectedDeploymentId': 'old', 'quiescenceConfirmed': True}
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert io.requests == []
    io = due('unknown'); make(io).run('scheduled'); event = no_pending_event(io)
    io.status = 'UPDATE_IN_PROGRESS'
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert io.requests == []


def test_no_pending_token_is_invalidated_by_certificate_change_and_completion():
    io = due('unknown'); make(io).run('scheduled'); event = no_pending_event(io)
    io.cert['version'] = 'v3'
    make(io).run('scheduled')
    assert io.state['recoveryToken'] != event['expectedStateToken']
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    io.logs = [{'taskArn': 't1', 'versionId': 'v3', **META}]
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v3' and 'recoveryToken' not in io.state
    assert io.requests == []


def test_automatic_deployment_requires_sole_completed_primary():
    io = due('mismatch')
    io.deployments = [{'id': 'old', 'status': 'ACTIVE', 'rolloutState': 'COMPLETED'}]
    make(io).run('scheduled')
    assert io.issued == 1 and io.requests == [] and io.state['deployed'] == 'v1'


def test_promoted_certificate_never_adopts_old_version_task_proof():
    io = due('mismatch'); pending(io, 'old'); io.state['pending']['version'] = 'v1'
    io.logs = [{'taskArn': 't1', 'versionId': 'v1', **io.cert['meta']}]
    make(io).run('scheduled')
    assert io.cert['version'] == 'v2' and io.state['deployed'] == 'v1'
    assert io.state['pending']['version'] == 'v1' and io.requests == []


def test_no_pending_recovery_event_is_consumed_even_if_request_is_definitively_rejected():
    from workflow import DeploymentRejected
    io = due('unknown'); make(io).run('scheduled'); event = no_pending_event(io)
    attempts = []
    def reject():
        attempts.append(True)
        raise DeploymentRejected()
    io.deploy = reject
    make(io).run('reconcile', recovery=event)
    assert io.state['result'] == 'rejected' and not io.state.get('pending')
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert len(attempts) == 1
