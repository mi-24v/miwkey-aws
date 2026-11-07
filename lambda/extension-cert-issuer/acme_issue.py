"""ACME account persistence and issuance with bounded cleanup."""
import asyncio
import json
import logging
from urllib.parse import urlsplit
from cryptography import x509
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from gufo.acme.clients.base import AcmeClient
from dns01 import DnsClient

DIRECTORIES = {False: 'https://acme-v02.api.letsencrypt.org/directory',
                True: 'https://acme-staging-v02.api.letsencrypt.org/directory'}
# Dependency error messages may include remote response bodies. Never log them.
logging.getLogger('gufo.acme').disabled = True


def restore(state, staging, api):
    value = json.loads(state)
    directory = DIRECTORIES[staging]
    account = urlsplit(value.get('account_url', ''))
    if value.get('directory') != directory or account.scheme != 'https' or account.netloc != urlsplit(directory).netloc or not account.path.startswith('/acme/acct/') or account.query or account.fragment:
        raise ValueError('ACME account environment mismatch')
    client = DnsClient.from_state(state.encode(), api=api, timeout=15)
    if not client.is_bound(): raise ValueError('ACME account is not initialized')
    return client


async def bootstrap_account(staging, api, email):
    client = DnsClient(DIRECTORIES[staging], key=AcmeClient.get_key(), api=api, timeout=15)
    await client.new_account(email)
    return client.get_state().decode()


async def issue(state, staging, api, fqdn):
    client = restore(state, staging, api)
    key = ec.generate_private_key(ec.SECP256R1())
    csr = (x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, fqdn)]))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName(fqdn)]), critical=False).sign(key, hashes.SHA256()))
    try:
        async with asyncio.timeout(600):
            certificate = await client.sign(fqdn, csr.public_bytes(serialization.Encoding.PEM))
    finally:
        # gufo's orchestration clears on success; this also handles authorization failure/timeouts.
        await client.cleanup()
    return {'certificatePem': certificate.decode(),
            'privateKeyPem': key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}
