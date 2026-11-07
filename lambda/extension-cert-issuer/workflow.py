"""Certificate promotion, observed deployment proof and guarded recovery."""
from datetime import datetime, timezone
import json
import uuid


class DeploymentRejected(Exception):
    """A definitive API rejection, with no remote message attached."""


def timestamp(value):
    if isinstance(value, (float, int)): return value
    if isinstance(value, datetime): return value.timestamp()
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


STABLE_STACKS = ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE')


class Engine:
    def __init__(self, io, validate, now=None, renewal_days=30):
        self.io = io
        self.validate = validate
        self.now = now if now is not None else datetime.now(timezone.utc).timestamp()
        self.renewal_days = renewal_days
        self.phase = 'invocation'
        self.metrics = {name: 0 for name in ('UnknownTasks', 'MismatchTasks', 'ApplyFailure', 'ApplyDelayDays',
                        'IssueFailure', 'DeployRequestFailure', 'TokenFailure', 'AccountFailure', 'ObserveFailure', 'ValidationFailure', 'StorageFailure')}

    def days(self, meta):
        return (timestamp(meta['notAfter']) - self.now) / 86400

    def observe(self, current):
        self.phase = 'observe'
        status, deployments, tasks, logs, desired = self.io.observe()
        by_task = {item['taskArn']: item for item in logs}
        known = [by_task[t['taskArn']] for t in tasks if t['taskArn'] in by_task]
        self.metrics['UnknownTasks'] = len(tasks) - len(known) + max(0, desired - len(tasks))
        if known: self.metrics['ServingDays'] = min(self.days(item) for item in known)
        if current:
            self.metrics['MismatchTasks'] = sum(not self.matches(log, current) for log in known)
        return status, deployments, tasks, by_task, desired

    @staticmethod
    def matches(log, current):
        return log.get('versionId') == current['version'] and all(
            log.get(k) == current['meta'][k] for k in ('fingerprint', 'notAfter'))

    def publish(self, current, value, staging):
        self.phase = 'validate'
        meta = self.validate(value, staging)
        self.phase = 'store'
        version = self.io.put_candidate(value, current, staging)
        if current:
            reread = self.io.read_candidate(version, staging)
            self.phase = 'validate'
            if self.validate(reread, staging) != meta: raise ValueError('candidate changed during readback')
            self.phase = 'promote'
            self.io.promote(version, current['version'])
        print(json.dumps({'event': 'certificate-stored', 'versionId': version,
                          'fingerprint': meta['fingerprint'], 'notAfter': meta['notAfter']}))
        return {'version': version, 'value': value, 'meta': meta}

    def save(self, state):
        self.phase = 'save-state'
        self.io.save_state(state)

    def unresolved(self, state, result, failed=False):
        state['result'] = result
        state.setdefault('unresolvedSince', self.now)
        state.setdefault('recoveryToken', str(uuid.uuid4()))
        self.metrics['ApplyDelayDays'] = max(0, (self.now - state['unresolvedSince']) / 86400)
        self.metrics['ApplyFailure'] = int(failed)
        self.save(state)

    @staticmethod
    def state_token(state):
        return (state.get('pending') or {}).get('intentId') or state.get('recoveryToken')

    def request(self, current, state, deployments):
        self.phase = 'validate'
        self.validate(current['value'], False)
        state['pending'] = {'version': current['version'], 'deploymentId': None, 'meta': current['meta'],
                            'intentId': str(uuid.uuid4()), 'beforeDeploymentIds': [d['id'] for d in deployments]}
        state.pop('recoveryToken', None)  # Consume the recovery capability in the write-ahead save.
        state['attempts'] = state.get('attempts', 0) + 1
        state['attemptedAt'] = self.now
        state.setdefault('unresolvedSince', self.now)
        state['result'] = 'requesting'
        # Write-ahead intent must succeed before sending the non-idempotent request.
        self.save(state)
        self.phase = 'deploy'
        try:
            deployment_id = self.io.deploy()
        except DeploymentRejected:
            state.pop('pending')
            self.unresolved(state, 'rejected', failed=True)
            return
        except Exception:
            self.unresolved(state, 'ambiguous')
            self.phase = 'deploy'
            raise
        state['pending']['deploymentId'] = deployment_id
        state['result'] = 'requested'
        self.save(state)

    def apply(self, current, state, observation, recovery=None):
        self.phase = 'apply'
        status, deployments, tasks, logs, desired = observation
        if state.get('current') != current['version']:
            state.pop('recoveryToken', None)
        state['current'] = current['version']
        pending = state.get('pending')
        if recovery is not None:
            # A stale/replayed recovery request cannot clear a newer persisted intent.
            self.phase = 'recovery-guard'
            expected = {'expectedVersionId', 'expectedStateToken', 'expectedDeploymentId', 'quiescenceConfirmed'}
            if (not isinstance(recovery, dict) or set(recovery) != expected or
                recovery['quiescenceConfirmed'] is not True or
                not self.state_token(state) or (not pending and 'unresolvedSince' not in state) or
                recovery['expectedVersionId'] != current['version'] or
                recovery['expectedStateToken'] != self.state_token(state) or
                status not in STABLE_STACKS or len(deployments) != 1 or
                deployments[0].get('status', 'PRIMARY') != 'PRIMARY' or
                deployments[0]['id'] != recovery['expectedDeploymentId'] or
                deployments[0].get('rolloutState') not in ('COMPLETED', 'FAILED')):
                raise ValueError('recovery preconditions no longer match')
        # Promotion may supersede an uncertain request; retain its write-ahead intent.
        # Only full serving proof or guarded recovery can retire it.
        primary = deployments[0] if len(deployments) == 1 else None
        # This proof works for lost responses, CFN replacement and first startup alike.
        proven = (status in STABLE_STACKS and primary and primary.get('status', 'PRIMARY') == 'PRIMARY' and
                  primary.get('rolloutState') == 'COMPLETED' and len(tasks) >= desired > 0 and
                  all(t.get('startedBy') == primary['id'] and self.matches(logs.get(t['taskArn'], {}), current) for t in tasks))
        if proven:
            state['deployed'] = current['version']; state.pop('pending', None); state.pop('unresolvedSince', None); state.pop('recoveryToken', None)
            state['result'] = 'completed'; self.save(state)
            return
        if recovery is not None:
            # Operator explicitly verified quiescence; replace one failed/ambiguous intent once.
            self.request(current, state, deployments)
            return
        if pending:
            deployment = next((d for d in deployments if d['id'] == pending.get('deploymentId')), None)
            if deployment is None and pending.get('deploymentId') is None:
                candidates = [d for d in deployments if d.get('status') == 'PRIMARY' and
                              d['id'] not in pending.get('beforeDeploymentIds', []) and
                              d.get('createdAt') is not None and timestamp(d['createdAt']) >= state.get('attemptedAt', self.now)]
                if len(candidates) == 1:
                    deployment = candidates[0]; pending['deploymentId'] = deployment['id']
            if deployment and deployment.get('rolloutState') == 'FAILED':
                self.unresolved(state, 'failed', failed=True)
            elif deployment:
                self.unresolved(state, 'awaiting-rollout-and-logs')
            else:
                self.unresolved(state, 'ambiguous' if pending.get('deploymentId') is None else 'replaced')
            return
        if (status not in STABLE_STACKS or not primary or primary.get('status', 'PRIMARY') != 'PRIMARY' or
            primary.get('rolloutState') != 'COMPLETED'):
            self.unresolved(state, 'deferred')
            return
        if self.metrics['UnknownTasks']:
            self.unresolved(state, 'awaiting-logs')
            return
        self.request(current, state, deployments)

    def run(self, mode, force=False, staging=False, recovery=None):
        if mode not in ('bootstrap', 'scheduled', 'reconcile') or staging and mode != 'bootstrap' or mode == 'reconcile' and (force or recovery is None):
            raise ValueError('invalid invocation mode')
        if mode == 'scheduled': self.metrics['Heartbeat'] = 1
        try:
            self.phase = 'token'; token = self.io.token()
            self.phase = 'account'; self.io.account(mode == 'bootstrap', staging)
            self.phase = 'read-certificate'; current = self.io.current(staging)
            if current: self.metrics['CurrentDays'] = self.days(current['meta'])
            if mode == 'bootstrap':
                if not current or force or self.days(current['meta']) <= self.renewal_days:
                    self.phase = 'issue'; value = self.io.issue(token, True, staging)
                    self.publish(current, value, staging)
                return
            self.phase = 'load-state'; state = self.io.load_state()
            observation = self.observe(current)
            if mode == 'reconcile':
                if not current: raise ValueError('recovery requires an existing current certificate')
                self.apply(current, state, observation, recovery=recovery)
                return
            renewed = False
            if not current or force or self.days(current['meta']) <= self.renewal_days:
                self.phase = 'issue'; value = self.io.issue(token, False, False)
                current = self.publish(current, value, False)
                self.metrics['CurrentDays'] = self.days(current['meta'])
                renewed = True
            if renewed or state.get('pending') or current['version'] != state.get('deployed') or self.metrics['MismatchTasks'] or self.metrics['UnknownTasks']:
                self.apply(current, state, observation)
        except Exception as error:
            metric = {'token': 'TokenFailure', 'account': 'AccountFailure', 'observe': 'ObserveFailure',
                      'validate': 'ValidationFailure', 'read-certificate': 'ValidationFailure',
                      'store': 'StorageFailure', 'promote': 'StorageFailure', 'save-state': 'StorageFailure', 'load-state': 'StorageFailure',
                      'deploy': 'DeployRequestFailure', 'recovery-guard': 'ApplyFailure', 'apply': 'ApplyFailure'}.get(self.phase, 'IssueFailure')
            self.metrics[metric] = 1
            print(json.dumps({'event': 'issuer-failure', 'stage': self.phase, 'errorType': type(error).__name__}))
            raise
        finally:
            self.io.metrics(self.metrics)
