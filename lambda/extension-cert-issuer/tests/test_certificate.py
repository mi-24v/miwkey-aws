from datetime import datetime, timedelta, timezone
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from certificate import validate, production_validate

NOW = datetime(2026, 10, 17, tzinfo=timezone.utc)
FQDN = 'notifications.example.com'

def bundle(name=FQDN, days=90):
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Test root')])
    root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
            .public_key(root_key.public_key()).serial_number(1)
            .not_valid_before(NOW - timedelta(days=3)).not_valid_after(NOW + timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), False)
            .sign(root_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
            .issuer_name(root_name).public_key(key.public_key()).serial_number(2)
            .not_valid_before(NOW - timedelta(days=2)).not_valid_after(NOW + timedelta(days=days))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), False)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False)
            .sign(root_key, hashes.SHA256()))
    pem = lambda cert: cert.public_bytes(serialization.Encoding.PEM).decode()
    return {'certificatePem': pem(leaf), 'privateKeyPem': key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}, [root]

def test_accepts_valid_chain_and_reports_only_public_metadata():
    value, roots = bundle()
    meta = validate(value, FQDN, roots, NOW)
    assert meta['notAfter'] == '2027-01-15T00:00:00Z'
    assert len(meta['fingerprint']) == 64
    assert 'PRIVATE' not in str(meta)

@pytest.mark.parametrize('kind', ['key', 'san', 'expired', 'root', 'malformed'])
def test_rejects_invalid_candidate_without_secret_in_error(kind):
    value, roots = bundle(name='wrong.example.com' if kind == 'san' else FQDN, days=-1 if kind == 'expired' else 90)
    if kind == 'key': value['privateKeyPem'] = bundle()[0]['privateKeyPem']
    if kind == 'root': roots = bundle()[1]
    if kind == 'malformed': value['certificatePem'] = 'SECRET-MARKER'
    with pytest.raises(ValueError) as error:
        validate(value, FQDN, roots, NOW)
    assert 'SECRET-MARKER' not in str(error.value)
    assert 'PRIVATE' not in str(error.value)

def test_production_does_not_trust_test_or_staging_roots():
    value, _ = bundle()
    with pytest.raises(ValueError): production_validate(value, FQDN, NOW)
