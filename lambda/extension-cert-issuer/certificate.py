"""In-memory verification. Production trust contains public roots only."""
from datetime import datetime, timezone
from pathlib import Path
import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.verification import PolicyBuilder, Store


def metadata(value):
    leaf = x509.load_pem_x509_certificates(value['certificatePem'].encode())[0]
    return {'fingerprint': leaf.fingerprint(hashes.SHA256()).hex(),
            'notAfter': leaf.not_valid_after_utc.isoformat().replace('+00:00', 'Z')}


def validate(value, fqdn, roots, now=None):
    try:
        chain = x509.load_pem_x509_certificates(value['certificatePem'].encode())
        key = serialization.load_pem_private_key(value['privateKeyPem'].encode(), password=None)
        encode = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if encode(key.public_key()) != encode(chain[0].public_key()):
            raise ValueError('key mismatch')
        names = chain[0].extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if list(names) != [x509.DNSName(fqdn)]:
            raise ValueError('unexpected SAN')
        (PolicyBuilder().store(Store(roots)).time(now or datetime.now(timezone.utc))
         .build_server_verifier(x509.DNSName(fqdn)).verify(chain[0], chain[1:]))
        return metadata(value)
    except Exception:
        raise ValueError('certificate validation failed') from None


def production_validate(value, fqdn, now=None):
    return validate(value, fqdn, x509.load_pem_x509_certificates(Path(certifi.where()).read_bytes()), now)


def staging_validate(value, fqdn, now=None):
    # Separate trust context, never combined with certifi. Supplied only to rehearsal.
    # Roots: https://letsencrypt.org/docs/staging-environment/ (retrieved 2026-10-17).
    roots = x509.load_pem_x509_certificates(Path(__file__).with_name('staging-roots.pem').read_bytes())
    return validate(value, fqdn, roots, now)
