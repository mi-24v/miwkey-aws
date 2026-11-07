"""Development-only expanded oracle corpus, including the Opus review reproductions.

Generate SHA-1 inputs with signature-fixtures.sh in the pinned AL2023 image, then
run this script with output JSON path and fixture directory as its arguments.
All generated keys are disposable test data; this file is excluded from runtime.
"""
import sys, json, datetime as dt
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from certificate import validate
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa, ed25519, ed448, padding, mldsa

NOW = dt.datetime(2026, 10, 17, tzinfo=dt.timezone.utc)
FQDN = 'notifications.example.com'
pem = lambda c: c.public_bytes(serialization.Encoding.PEM).decode()
der = lambda c: c.public_bytes(serialization.Encoding.DER)
keypem = lambda k: k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
name = lambda cn: x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]) if cn else x509.Name([])
eckey = lambda: ec.generate_private_key(ec.SECP256R1())

def build(key, subject, issuer, ikey, ca=False, san=(FQDN,), san_critical=False, nb=None, na=None, alg='sha256', pss=None):
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(key.public_key())
         .serial_number(x509.random_serial_number())
         .not_valid_before(nb or NOW - dt.timedelta(days=3)).not_valid_after(na or NOW + dt.timedelta(days=365 if ca else 30)))
    b = b.add_extension(x509.BasicConstraints(ca, None), True)
    b = b.add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
    b = b.add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ikey.public_key()), False)
    if ca:
        b = b.add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), True)
    else:
        b = b.add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), True)
        b = b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
        if san is not None:
            b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in san]), san_critical)
    algorithm = None if isinstance(ikey, (ed25519.Ed25519PrivateKey,ed448.Ed448PrivateKey,mldsa.MLDSA44PrivateKey,mldsa.MLDSA65PrivateKey,mldsa.MLDSA87PrivateKey)) else {'sha256': hashes.SHA256(), 'sha384':hashes.SHA384(),'sha512':hashes.SHA512(),'sha224':hashes.SHA224(),'sha1': hashes.SHA1()}[alg]
    return b.sign(ikey, algorithm, rsa_padding=pss)

def root(cn, key=None, nb=None, na=None):
    key = key or eckey()
    return key, build(key, name(cn), name(cn), key, ca=True, nb=nb, na=na)

def relabel(c, label):
    return pem(c).replace('BEGIN CERTIFICATE', 'BEGIN ' + label).replace('END CERTIFICATE', 'END ' + label)

def der_pem(raw):
    import base64, textwrap
    return '-----BEGIN CERTIFICATE-----\n' + '\n'.join(textwrap.wrap(base64.b64encode(raw).decode(), 64)) + '\n-----END CERTIFICATE-----\n'

cases = []
def add(case, bundle, key, roots, now=NOW, note='', **extra):
    value = {'certificatePem': bundle, 'privateKeyPem': keypem(key)}
    try:
        meta = validate(value, FQDN, roots, now); accepted = True
    except ValueError:
        meta = None; accepted = False
    cases.append({'name': case, 'now': now.isoformat(), 'value': value, 'roots': ''.join(map(pem, roots)),
                  'accepted': accepted, 'meta': meta, 'note': note, **extra})

rk, r = root('Probe Root')
lk = eckey(); leaf = build(lk, name(FQDN), r.subject, rk)
add('baseline-valid', pem(leaf), lk, [r], note='positive control')

S = sys.argv[2]
load = lambda f: x509.load_pem_x509_certificate(open(S + '/' + f, 'rb').read())
lkey = lambda f: serialization.load_pem_private_key(open(S + '/' + f, 'rb').read(), None)
rr = load('root.pem')
add('sha1-signed-leaf', pem(load('leaf-sha1.pem')), lkey('leaf.key'), [rr], note='sha1WithRSAEncryption leaf signature (openssl CLI fixture)')
add('sha1-signed-intermediate', pem(load('leaf2.pem')) + pem(load('inter-sha1.pem')), lkey('leaf2.key'), [rr], note='intermediate signed with SHA-1 (openssl CLI fixture)')
k = rsa.generate_private_key(public_exponent=65537, key_size=1024); add('rsa1024-leaf', pem(build(k, name(FQDN), r.subject, rk)), k, [r], note='RSA-1024 leaf key')
k = rsa.generate_private_key(public_exponent=65537, key_size=2048); add('rsa2048-leaf', pem(build(k, name(FQDN), r.subject, rk)), k, [r], note='positive control RSA-2048')
k = ec.generate_private_key(ec.SECP256K1()); add('secp256k1-leaf', pem(build(k, name(FQDN), r.subject, rk)), k, [r], note='non-WebPKI curve')
k = ed25519.Ed25519PrivateKey.generate(); add('ed25519-leaf', pem(build(k, name(FQDN), r.subject, rk)), k, [r], note='Ed25519 leaf key')
k = eckey(); add('empty-subject-critical-san', pem(build(k, name(None), r.subject, rk, san_critical=True)), k, [r], note='RFC 5280 4.2.1.6 form')
k = eckey(); add('empty-subject-noncritical-san', pem(build(k, name(None), r.subject, rk, san_critical=False)), k, [r], note='RFC violation')
k = eckey(); add('uppercase-san', pem(build(k, name(FQDN), r.subject, rk, san=('Notifications.example.com',))), k, [r], note='case variant')
lk = eckey(); valid = build(lk, name(FQDN), r.subject, rk)
expired = build(lk, name(FQDN), r.subject, rk, nb=NOW - dt.timedelta(days=60), na=NOW - dt.timedelta(days=1))
add('trusted-label-expired-same-key-prefix', relabel(expired, 'TRUSTED CERTIFICATE') + pem(valid), lk, [r], note='non-CERTIFICATE PEM label before leaf',
    validatedLeafPem=pem(valid), prefixPem=relabel(expired, 'TRUSTED CERTIFICATE'))
add('x509-label-expired-same-key-prefix', relabel(expired, 'X509 CERTIFICATE') + pem(valid), lk, [r], note='legacy X509 CERTIFICATE label before leaf',
    validatedLeafPem=pem(valid), prefixPem=relabel(expired, 'X509 CERTIFICATE'))
add('trusted-label-root-prefix', relabel(r, 'TRUSTED CERTIFICATE') + pem(valid), lk, [r], note='root relabelled before leaf', validatedLeafPem=pem(valid))
add('der-trailing-empty-aux', der_pem(der(valid) + b'\x30\x00'), lk, [r], note='DER followed by empty X509_CERT_AUX SEQUENCE')
add('der-trailing-garbage', der_pem(der(valid) + b'\x00\x01'), lk, [r], note='DER followed by non-ASN.1 bytes')
ak, a = root('Probe Expired Root A', nb=NOW - dt.timedelta(days=400), na=NOW - dt.timedelta(days=1))
bk, b = root('Probe Root B')
sk = eckey(); ia = build(sk, name('Shared Intermediate'), a.subject, ak, ca=True); ib = build(sk, name('Shared Intermediate'), b.subject, bk, ca=True)
k = eckey(); add('alternate-chain-expired-first', pem(build(k, name(FQDN), ia.subject, sk)) + pem(ia) + pem(ib), k, [a, b], note='first path expired root, second valid')
xk, xroot = root('Probe OS Root'); yk, yroot = root('Probe Unrelated Root')
k = eckey(); add('os-store-root-only', pem(build(k, name(FQDN), xroot.subject, xk)), k, [yroot], note='issuer root supplied only through OS env store', osRootPem=pem(xroot))

# Signature policy probes distinguish leaf SPKI from issuer/signature algorithms.
for algorithm in ['sha256','sha384','sha512','sha224']:
    for family in ['rsa','ecdsa']:
        ik = rsa.generate_private_key(public_exponent=65537,key_size=2048) if family=='rsa' else eckey()
        ir = build(ik,name('Signature Root'),name('Signature Root'),ik,ca=True)
        k = eckey()
        add(f'{family}-{algorithm}',pem(build(k,name(FQDN),ir.subject,ik,alg=algorithm)),k,[ir])
for family, ik in [('ed25519',ed25519.Ed25519PrivateKey.generate()),('ed448',ed448.Ed448PrivateKey.generate())]:
    ir=build(ik,name('Ed Root'),name('Ed Root'),ik,ca=True);k=eckey()
    add(f'{family}-signed-leaf',pem(build(k,name(FQDN),ir.subject,ik)),k,[ir])
ik=rsa.generate_private_key(public_exponent=65537,key_size=2048)
ir=build(ik,name('PSS Root'),name('PSS Root'),ik,ca=True)
for algorithm,size in [('sha256',32),('sha384',48),('sha512',64)]:
    for variant in ['valid','wrong-mgf','wrong-salt']:
        digest={'sha256':hashes.SHA256,'sha384':hashes.SHA384,'sha512':hashes.SHA512}[algorithm]
        pss=padding.PSS(mgf=padding.MGF1(hashes.SHA256() if variant=='wrong-mgf' and algorithm!='sha256' else hashes.SHA384() if variant=='wrong-mgf' else digest()),salt_length=size-1 if variant=='wrong-salt' else size)
        k=eckey();add(f'pss-{algorithm}-{variant}',pem(build(k,name(FQDN),ir.subject,ik,alg=algorithm,pss=pss)),k,[ir])
# A root's self signature is excluded; a cross-signed intermediate is not.
# Sign a SHA256 leaf under a SHA1-self-signed CA via the pinned CLI fixture below.
if (Path(S)/'root-sha1.pem').exists():
    sr=load('root-sha1.pem');k=eckey()
    add('sha1-anchor-excluded',pem(build(k,name(FQDN),sr.subject,lkey('root.key'))),k,[sr])
# First cross-signature has forbidden PSS parameters; valid alternate must still work.
sk=eckey();good=build(sk,name('Shared Policy Intermediate'),ir.subject,ik,ca=True)
bad=build(sk,name('Shared Policy Intermediate'),ir.subject,ik,ca=True,pss=padding.PSS(mgf=padding.MGF1(hashes.SHA256()),salt_length=31))
k=eckey();add('alternate-signature-policy-first-invalid',pem(build(k,name(FQDN),good.subject,sk))+pem(bad)+pem(good),k,[ir])
for family, ik in [('rsa1024',rsa.generate_private_key(public_exponent=65537,key_size=1024)),('secp256k1',ec.generate_private_key(ec.SECP256K1()))]:
    ir=build(ik,name('Issuer Policy Root'),name('Issuer Policy Root'),ik,ca=True);k=eckey()
    add(f'{family}-issuer',pem(build(k,name(FQDN),ir.subject,ik)),k,[ir])
k=ed448.Ed448PrivateKey.generate();add('ed448-leaf',pem(build(k,name(FQDN),r.subject,rk)),k,[r])
for size, keytype in [(44,mldsa.MLDSA44PrivateKey),(65,mldsa.MLDSA65PrivateKey),(87,mldsa.MLDSA87PrivateKey)]:
    ik=keytype.generate();ir=build(ik,name('MLDSA Root'),name('MLDSA Root'),ik,ca=True);k=eckey()
    add(f'mldsa{size}-signature',pem(build(k,name(FQDN),ir.subject,ik)),k,[ir])
# The expected values below are deliberate policy literals, not derived expectations.
for c in cases:
    n=c['name']
    c['expected']=not(any(x in n for x in ['sha1-signed','sha224','-signed-leaf','wrong-mgf','wrong-salt','empty-subject-noncritical','uppercase','der-trailing','x509-label','os-store','-issuer']))
    if n in ['trusted-label-expired-same-key-prefix','trusted-label-root-prefix']:c['expected']=True;c['tsExpected']=False
json.dump({'fqdn':FQDN,'now':NOW.isoformat(),'cases':cases},open(sys.argv[1],'w'))
print(json.dumps([{c['name']:c['accepted']} for c in cases]))
