from copy import deepcopy
import pytest
from test_workflow import MemoryIO, META, make


def unserved():
    io = MemoryIO()
    io.cert['version'] = 'v2'
    return io


def pending(io, deployment_id=None):
    io.state['attemptedAt'] = 1792195000
    io.state['pending'] = {'version': 'v2', 'deploymentId': deployment_id, 'meta': META,
                           'intentId': 'intent-one', 'beforeDeploymentIds': ['old']}


def served(io, deployment='replacement'):
    io.deployments = [{'id': deployment, 'status': 'PRIMARY', 'rolloutState': 'COMPLETED', 'createdAt': 1792195100}]
    io.tasks = [{'taskArn': 't1', 'startedBy': deployment}]
    io.logs = [{'taskArn': 't1', 'versionId': 'v2', **META}]


def recovery(io):
    return {'expectedVersionId': 'v2', 'expectedStateToken': 'intent-one', 'expectedDeploymentId': io.deployments[0]['id'], 'quiescenceConfirmed': True}


def test_unknown_response_adopts_unique_new_primary_without_resending():
    io = unserved(); pending(io)
    io.deployments = [{'id': 'new', 'status': 'PRIMARY', 'rolloutState': 'IN_PROGRESS', 'createdAt': 1792195100}]
    make(io).run('scheduled')
    assert io.state['pending']['deploymentId'] == 'new'
    assert io.state['result'] == 'awaiting-rollout-and-logs'
    assert io.requests == [] and io.issued == 0
    served(io, 'new'); make(io).run('scheduled')
    assert io.state['deployed'] == 'v2' and not io.state.get('pending')


def test_pre_send_crash_stays_ambiguous_until_guarded_manual_recovery():
    io = unserved(); pending(io)
    make(io).run('scheduled')
    assert io.state['result'] == 'ambiguous'
    assert io.requests == [] and io.state['deployed'] == 'v1'
    event = recovery(io)
    make(io).run('reconcile', recovery=event)
    assert io.requests == [{'forceNewDeployment': True}] and io.issued == 0
    assert io.state['pending']['intentId'] != 'intent-one'
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert len(io.requests) == 1


@pytest.mark.parametrize('old', ['missing', 'failed'])
def test_completed_replacement_can_confirm_only_all_current_logs(old):
    io = unserved(); pending(io, old); served(io)
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v2' and io.state['result'] == 'completed'
    assert io.requests == [] and io.issued == 0


def test_missing_log_is_never_proof_of_success_or_reason_for_automatic_retry():
    io = unserved(); pending(io, 'gone'); served(io); io.logs = []
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v1' and io.state.get('pending')
    assert io.requests == [] and io.telemetry['UnknownTasks'] == 1


def test_genuine_failed_rollout_can_be_recovered_once_explicitly():
    io = unserved(); pending(io, 'failed')
    io.deployments = [{'id': 'failed', 'status': 'PRIMARY', 'rolloutState': 'FAILED'}]
    make(io).run('scheduled')
    assert io.state['result'] == 'failed' and io.telemetry['ApplyFailure'] == 1
    make(io).run('reconcile', recovery=recovery(io))
    assert len(io.requests) == 1 and io.issued == 0


@pytest.mark.parametrize('field,value', [('expectedVersionId', 'wrong'), ('expectedStateToken', 'wrong'), ('expectedDeploymentId', 'wrong')])
def test_manual_recovery_rejects_stale_observations(field, value):
    io = unserved(); pending(io)
    event = {**recovery(io), field: value}
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=event)
    assert io.requests == []


def test_manual_recovery_refuses_concurrent_stack_or_ecs_update():
    io = unserved(); pending(io); io.status = 'UPDATE_IN_PROGRESS'
    with pytest.raises(ValueError): make(io).run('reconcile', recovery=recovery(io))
    assert io.requests == []


def test_final_save_failure_is_reconciled_from_persisted_intent_and_actual_tasks():
    io = unserved()
    original = io.save_state
    def fail_on_requested(state):
        if state.get('result') == 'requested': raise OSError('storage unavailable')
        original(state)
    io.save_state = fail_on_requested
    with pytest.raises(OSError): make(io).run('scheduled')
    assert len(io.requests) == 1 and io.state['pending']['deploymentId'] is None
    io.save_state = original; served(io, 'ecs-new')
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v2' and len(io.requests) == 1


def test_healthy_requests_and_waiting_do_not_report_apply_failure():
    io = unserved(); make(io).run('scheduled')
    assert io.telemetry['ApplyFailure'] == 0
    io.deployments = [{'id': 'ecs-new', 'status': 'PRIMARY', 'rolloutState': 'IN_PROGRESS'}]
    make(io).run('scheduled')
    assert io.telemetry['ApplyFailure'] == 0


def test_deferred_warning_uses_elapsed_time_not_manual_invocation_count():
    io = unserved(); io.status = 'UPDATE_IN_PROGRESS'
    for _ in range(4): make(io).run('scheduled')
    assert io.telemetry['ApplyFailure'] == 0 and io.telemetry['ApplyDelayDays'] == 0
    engine = make(io); engine.now += 2*86400; engine.run('scheduled')
    assert io.telemetry['ApplyDelayDays'] == 2


def test_already_serving_current_on_first_invocation_requires_no_deploy():
    io = unserved(); io.state = {}; served(io)
    make(io).run('scheduled')
    assert io.state['deployed'] == 'v2' and io.requests == []


def test_certificate_drift_is_detected_even_without_pending():
    io = unserved(); io.state['deployed'] = 'v2'
    make(io).run('scheduled')
    assert io.telemetry['MismatchTasks'] == 1
    assert len(io.requests) == 1


def test_failure_logs_distinguish_token_from_issue_without_messages(capsys):
    io = MemoryIO(); io.bad_token = True
    with pytest.raises(ValueError): make(io).run('scheduled')
    import json
    logs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert {'event': 'issuer-failure', 'stage': 'token', 'errorType': 'ValueError'} in logs
    assert io.telemetry['TokenFailure'] == 1 and io.telemetry['IssueFailure'] == 0

def test_definitive_rejection_releases_pending_without_reissuing_certificate():
    from workflow import DeploymentRejected
    io = unserved()
    def reject(): raise DeploymentRejected()
    io.deploy = reject
    make(io).run('scheduled')
    assert io.state['result'] == 'rejected' and not io.state.get('pending')
    assert io.telemetry['ApplyFailure'] == 1 and io.issued == 0


def test_unknown_send_exception_keeps_intent_and_never_blindly_retries():
    io = unserved()
    def uncertain():
        io.requests.append({'forceNewDeployment': True})
        raise TimeoutError('response lost')
    io.deploy = uncertain
    with pytest.raises(TimeoutError): make(io).run('scheduled')
    assert io.state['result'] == 'ambiguous'
    make(io).run('scheduled')
    assert len(io.requests) == 1 and io.issued == 0


def test_failed_intent_save_prevents_any_update_service_request():
    io = unserved()
    def unavailable(state): raise OSError('store unavailable')
    io.save_state = unavailable
    with pytest.raises(OSError): make(io).run('scheduled')
    assert io.requests == []

def test_lambda_recovery_event_routes_through_the_guarded_state_machine(monkeypatch):
    import handler
    io = unserved(); pending(io)
    monkeypatch.setattr(handler, 'AwsIO', lambda config: io)
    monkeypatch.setattr(handler, 'production_validate', lambda *args: META)
    monkeypatch.setenv('RENEWAL_DAYS', '30'); monkeypatch.setenv('FQDN', 'notifications.example.com')
    event = {'mode': 'reconcile', 'recovery': recovery(io)}
    assert handler.handler(event, None) == {'result': 'complete'}
    assert len(io.requests) == 1 and 'Heartbeat' not in io.telemetry
    with pytest.raises(RuntimeError): handler.handler(event, None)
    assert len(io.requests) == 1
