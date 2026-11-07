"""Cloudflare DNS-01: additive records and ownership-checked cleanup."""
import asyncio
import base64
import hashlib
import json
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid
from copy import deepcopy
import dns.resolver
from gufo.acme.clients.base import AcmeClient


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('redirect refused')


class Cloudflare:
    def __init__(self, zone, token, transport=None, pause=time.sleep):
        self.base = f'/zones/{zone}/dns_records'
        self.token = token
        self.transport = transport or self.http
        self.pause = pause

    def http(self, method, path, data=None):
        req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path,
            data=json.dumps(data).encode() if data is not None else None, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=10) as response:
            value = json.load(response)
        if not value.get('success'): raise ValueError('Cloudflare rejected request')
        return value['result']

    def request(self, method, path, data=None):
        # Never repeat a non-idempotent POST after an ambiguous response.
        for attempt in range(1 if method == 'POST' else 3):
            try: return self.transport(method, path, data)
            except urllib.error.HTTPError as error:
                if error.code < 500 and error.code != 429: break
            except Exception:
                pass
            if attempt < 2 and method != 'POST': self.pause(2**attempt)
        raise ValueError('Cloudflare request failed') from None

    def check(self):
        self.request('GET', self.base + '?type=TXT&per_page=1')

    def create(self, name, value):
        payload = {'name': name, 'type': 'TXT', 'content': value, 'ttl': 60,
                   'comment': 'miwkey-issuer:' + str(uuid.uuid4())}
        print(json.dumps({'event': 'dns-record-intent', 'name': name, 'comment': payload['comment']}))
        try:
            record = self.request('POST', self.base, payload)
        except ValueError:
            # Recover a possibly-created record without repeating POST or adopting another issuer's TXT.
            query = urllib.parse.urlencode({'comment.exact': payload['comment'], 'type': 'TXT', 'per_page': 100})
            record = None
            for attempt in range(3):
                matches = self.request('GET', self.base + '?' + query)
                owned = [r for r in matches if all(r.get(k) == payload[k] for k in ('name', 'content', 'type', 'comment'))]
                if len(owned) == 1:
                    record = owned[0]
                    break
                if len(owned) > 1: raise ValueError('ambiguous TXT ownership') from None
                if attempt < 2: self.pause(2**attempt)
            if record is None: raise ValueError('TXT creation outcome unknown') from None
        if not record.get('id'): raise ValueError('missing TXT record ID')
        print(json.dumps({'event': 'dns-record-created', 'recordId': record['id'], 'name': name, 'comment': payload['comment']}))
        return deepcopy(record)

    def get(self, record_id): return self.request('GET', self.base + '/' + record_id)
    def delete(self, record_id): return self.request('DELETE', self.base + '/' + record_id)


def owned_cleanup(api, record):
    current = api.get(record['id'])
    if any(current.get(k) != record.get(k) for k in ('name', 'type', 'content', 'comment')):
        raise ValueError('TXT ownership mismatch')
    api.delete(record['id'])


def public_txt(name, value):
    # Require both public resolvers to see this challenge; API state alone is insufficient.
    for server in ('1.1.1.1', '8.8.8.8'):
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = [server]
        try:
            answer = resolver.resolve(name + '.', 'TXT', lifetime=5, search=False)
            if value not in [b''.join(r.strings).decode() for r in answer]: return False
        except dns.exception.DNSException:
            return False
    return True


class DnsClient(AcmeClient):
    def __init__(self, *args, api, **kwargs):
        super().__init__(*args, **kwargs)
        self.api = api
        self.records = {}

    async def fulfill_dns_01(self, domain, challenge):
        value = base64.urlsafe_b64encode(hashlib.sha256(self.get_key_authorization(challenge)).digest()).rstrip(b'=').decode()
        name = '_acme-challenge.' + domain
        creation = asyncio.create_task(asyncio.to_thread(self.api.create, name, value))
        try:
            record = await asyncio.shield(creation)
        except asyncio.CancelledError:
            # Cancellation cannot stop the HTTP thread. Join it and retain ownership
            # before the caller's finally block attempts cleanup.
            record = await creation
            self.records[record['id']] = record
            raise
        self.records[record['id']] = record
        await asyncio.sleep(5)
        for _ in range(12):
            if await asyncio.to_thread(public_txt, name, value): return True
            await asyncio.sleep(5)
        raise ValueError('DNS propagation timed out')

    async def clear_dns_01(self, domain, challenge):
        await self.cleanup()

    async def cleanup(self):
        errors = []
        for record_id, record in list(self.records.items()):
            try:
                await asyncio.to_thread(owned_cleanup, self.api, record)
                del self.records[record_id]
            except Exception as error:
                print(json.dumps({'event': 'dns-cleanup-failed', 'recordId': record_id,
                                  'name': record.get('name'), 'comment': record.get('comment'),
                                  'errorType': type(error).__name__}))
                errors.append(record_id)
        if errors: raise ValueError('DNS cleanup failed')
