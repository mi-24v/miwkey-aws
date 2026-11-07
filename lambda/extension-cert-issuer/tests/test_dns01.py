import pytest
from dns01 import Cloudflare, owned_cleanup

class Records:
    def __init__(self):
        self.records = {'other': {'name': '_acme-challenge.notifications.example.com', 'type': 'TXT', 'content': 'existing'}}
        self.calls = []
    def __call__(self, method, path, data=None):
        self.calls.append((method, path))
        if method == 'POST':
            self.records['mine'] = {**data, 'id': 'mine'}; return self.records['mine']
        key = path.rsplit('/', 1)[-1]
        if method == 'GET': return self.records[key]
        if method == 'DELETE': return self.records.pop(key)

def test_cleanup_preserves_existing_txt_and_deletes_only_owned_id():
    records = Records(); api = Cloudflare('a'*32, 'secret', transport=records)
    record = api.create('_acme-challenge.notifications.example.com', 'new')
    owned_cleanup(api, record)
    assert set(records.records) == {'other'}

def test_cleanup_refuses_changed_name_or_value():
    records = Records(); api = Cloudflare('a'*32, 'secret', transport=records)
    record = api.create('_acme-challenge.notifications.example.com', 'new')
    records.records['mine']['content'] = 'someone else'
    with pytest.raises(ValueError): owned_cleanup(api, record)
    assert 'mine' in records.records

def test_http_retry_has_a_fixed_bound_and_hides_secret():
    attempts = []
    def fail(*args):
        attempts.append(1); raise OSError('token-SECRET')
    api = Cloudflare('a'*32, 'token-SECRET', transport=fail, pause=lambda _: None)
    with pytest.raises(ValueError) as error: api.get('mine')
    assert len(attempts) == 3
    assert 'SECRET' not in str(error.value)

def test_lost_create_response_recovers_only_record_with_unique_comment():
    records = Records()
    def ambiguous(method, path, data=None):
        if method == 'POST':
            records(method, path, data)
            raise OSError('response lost')
        if '?' in path:
            return [records.records['mine']]
        return records(method, path, data)
    api = Cloudflare('a'*32, 'token', transport=ambiguous, pause=lambda _: None)
    record = api.create('_acme-challenge.notifications.example.com', 'new')
    owned_cleanup(api, record)
    assert set(records.records) == {'other'}

def test_initial_propagation_delay_precedes_public_lookup(monkeypatch):
    import asyncio
    import dns01
    from gufo.acme.clients.base import AcmeClient
    from gufo.acme.types import AcmeChallenge
    events = []
    async def sleep(seconds): events.append(('sleep', seconds))
    def lookup(name, value):
        assert events[0] == ('sleep', 5)
        events.append(('query', name)); return True
    monkeypatch.setattr(dns01.asyncio, 'sleep', sleep)
    monkeypatch.setattr(dns01, 'public_txt', lookup)
    api = Cloudflare('a'*32, 'secret', transport=Records())
    async def run():
        client = dns01.DnsClient('https://example.com/directory', key=AcmeClient.get_key(), api=api)
        assert await client.fulfill_dns_01('notifications.example.com', AcmeChallenge('dns-01', 'https://example.com/challenge', 'fixture'))
        await client.cleanup()
    asyncio.run(run())


def test_cleanup_failure_preserves_record_id_without_secret_output(monkeypatch, capsys):
    import asyncio,json,dns01
    from gufo.acme.clients.base import AcmeClient
    api = Cloudflare('a'*32, 'fixture-token', transport=Records())
    client = dns01.DnsClient('https://example.com/directory', key=AcmeClient.get_key(), api=api)
    client.records['mine'] = {'id': 'mine', 'name': '_acme-challenge.notifications.example.com', 'content': 'fixture-TXT-secret', 'comment': 'miwkey-issuer:owned'}
    def fail(*args): raise ValueError('fixture-token')
    monkeypatch.setattr(dns01, 'owned_cleanup', fail)
    with pytest.raises(ValueError): asyncio.run(client.cleanup())
    logs = capsys.readouterr().out
    assert json.loads(logs)['recordId'] == 'mine'
    assert 'fixture-token' not in logs and 'fixture-TXT-secret' not in logs
    assert 'mine' in client.records


def test_cancelled_create_is_tracked_before_final_cleanup():
    import asyncio,threading,dns01
    from gufo.acme.clients.base import AcmeClient
    from gufo.acme.types import AcmeChallenge
    started, release = threading.Event(), threading.Event()
    records = Records()
    def delayed(method, path, data=None):
        if method == 'POST':
            started.set(); assert release.wait(timeout=2)
        return records(method, path, data)
    api = Cloudflare('a'*32, 'secret', transport=delayed)
    async def run():
        client = dns01.DnsClient('https://example.com/directory', key=AcmeClient.get_key(), api=api)
        task = asyncio.create_task(client.fulfill_dns_01('notifications.example.com', AcmeChallenge('dns-01', 'https://example.com/challenge', 'fixture')))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel(); release.set()
        with pytest.raises(asyncio.CancelledError): await task
        await client.cleanup()
    asyncio.run(run())
    assert set(records.records) == {'other'}
