"""Reviewer-only DER/ASN.1 counterexample corpus. Disposable keys generated at runtime."""
import sys, json, base64, datetime as dt
from pathlib import Path
LANE = str(Path(__file__).resolve().parents[3])
OUT = sys.argv[1]
sys.path.insert(0, LANE + '/lambda/extension-cert-issuer')
from certificate import validate  # Python oracle (unchanged since 4fb17eb)
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa, padding
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID, AuthorityInformationAccessOID
from cryptography.x509.verification import PolicyBuilder, Store

NOW = dt.datetime(2026, 10, 22, tzinfo=dt.timezone.utc)
FQDN = 'notifications.example.com'

def enc_len(n, form='min'):
    if form == 'min':
        if n < 128: return bytes([n])
        b = n.to_bytes((n.bit_length() + 7) // 8, 'big'); return bytes([0x80 | len(b)]) + b
    b = n.to_bytes(max(1, (n.bit_length() + 7) // 8), 'big')
    if n < 128: return bytes([0x81, n])            # long form for a short length
    return bytes([0x80 | (len(b) + 1), 0]) + b     # leading zero length octet
def tlv(tag, body, form='min'): return bytes([tag]) + enc_len(len(body), form) + body
def indef(tag, body): return bytes([tag, 0x80]) + body + b'\x00\x00'
def head(raw, p=0):
    tag = raw[p]; n = raw[p + 1]; s = p + 2
    if n & 128:
        c = n & 127; n = int.from_bytes(raw[s:s + c], 'big'); s += c
    return tag, s, s + n
def kids(raw):
    _, s, e = head(raw); out = []
    while s < e:
        _, _, ce = head(raw, s); out.append(raw[s:ce]); s = ce
    return out
def body(raw): _, s, e = head(raw); return raw[s:e]
def pem(raw): return '-----BEGIN CERTIFICATE-----\n' + base64.encodebytes(raw).decode() + '-----END CERTIFICATE-----\n'
def der(c): return c.public_bytes(serialization.Encoding.DER)
def oid_der(dotted): return x509.ObjectIdentifier(dotted)

def sign(signer, tbs):
    if isinstance(signer, ec.EllipticCurvePrivateKey): return signer.sign(tbs, ec.ECDSA(hashes.SHA256()))
    return signer.sign(tbs, padding.PKCS1v15(), hashes.SHA256())
def resign(cert_der, signer, edit_tbs):
    outer = kids(cert_der); tbs_parts = kids(outer[0])
    tbs = tlv(0x30, b''.join(edit_tbs(tbs_parts)))
    return tlv(0x30, tbs + outer[1] + tlv(3, b'\x00' + sign(signer, tbs)))

OIDS = {'san': '551d11', 'ku': '551d0f', 'bc': '551d13', 'eku': '551d25', 'ski': '551d0e', 'aki': '551d23',
        'aia': '2b06010505070101', 'cp': '551d20', 'crldp': '551d1f'}
def ext_edit(name, fn):
    """fn(parts) -> parts, where parts are the Extension SEQUENCE children [oid, (bool), octet]"""
    want = bytes.fromhex(OIDS[name])
    def edit(tbs):
        i = next(i for i, p in enumerate(tbs) if p[0] == 0xA3)
        exts = kids(tbs[i])  # A3 -> [SEQUENCE OF Extension]
        seq = exts[0]; items = kids(seq); hit = 0
        for j, item in enumerate(items):
            parts = kids(item)
            if body(parts[0]) == want:
                items[j] = tlv(0x30, b''.join(fn(parts))); hit += 1
        assert hit == 1, (name, hit)
        tbs[i] = tlv(0xA3, tlv(0x30, b''.join(items)))
        return tbs
    return edit
def value_edit(fn):
    """replace the extnValue OCTET STRING content via fn(inner_der)->new_inner (still primitive OCTET STRING)"""
    def f(parts):
        parts[-1] = tlv(0x04, fn(body(parts[-1]))); return parts
    return f
def relen_outer(inner, form='long'):
    tag, s, e = head(inner); return bytes([tag]) + enc_len(e - s, form) + inner[s:e]
def indef_outer(inner):
    tag, s, e = head(inner); return indef(tag | 0x20 if tag & 0x20 else tag, inner[s:e])

def name_of(cn): return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]) if cn else x509.Name([])
def build(key, subject, issuer, signer, ca=False, san_critical=False, extra=True, issuer_key=None):
    b = (x509.CertificateBuilder().subject_name(name_of(subject)).issuer_name(name_of(issuer)).public_key(key.public_key())
         .serial_number(0x1234567).not_valid_before(NOW - dt.timedelta(days=3)).not_valid_after(NOW + dt.timedelta(days=90)))
    b = b.add_extension(x509.BasicConstraints(ca, None), True)
    b = b.add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
    b = b.add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key((issuer_key or signer).public_key()), False)
    b = b.add_extension(x509.KeyUsage(not ca, False, False, False, False, ca, ca, False, False), True)
    if ca:
        b = b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False) if issuer != subject else b
    else:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(FQDN)]), san_critical)
        b = b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
        if extra:
            b = b.add_extension(x509.AuthorityInformationAccess([x509.AccessDescription(AuthorityInformationAccessOID.CA_ISSUERS, x509.UniformResourceIdentifier('http://ca.example/i.der'))]), False)
            b = b.add_extension(x509.CertificatePolicies([x509.PolicyInformation(x509.ObjectIdentifier('2.23.140.1.2.1'), None)]), False)
            b = b.add_extension(x509.CRLDistributionPoints([x509.DistributionPoint([x509.UniformResourceIdentifier('http://ca.example/c.crl')], None, None, None)]), False)
    algo = hashes.SHA256()
    return b.sign(signer, algo)

rk = ec.generate_private_key(ec.SECP256R1()); ik = ec.generate_private_key(ec.SECP256R1()); lk = ec.generate_private_key(ec.SECP256R1())
rsa_ik = rsa.generate_private_key(public_exponent=65537, key_size=2048)
root = build(rk, 'Reviewer Root', 'Reviewer Root', rk, ca=True)
inter = build(ik, 'Reviewer Intermediate', 'Reviewer Root', rk, ca=True)
leaf = build(lk, FQDN, 'Reviewer Intermediate', ik)
rinter = build(rsa_ik, 'Reviewer RSA Intermediate', 'Reviewer Root', rk, ca=True)
rleaf = build(lk, FQDN, 'Reviewer RSA Intermediate', rsa_ik)
keypem = lk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()

def why(chain, roots, now):
    try:
        cs = x509.load_pem_x509_certificates(''.join(pem(c) for c in chain).encode())
    except Exception as e: return 'load: %s: %s' % (type(e).__name__, str(e)[:160])
    try: cs[0].public_key()
    except Exception as e: return 'leaf public_key: %s: %s' % (type(e).__name__, str(e)[:160])
    try: cs[0].extensions
    except Exception as e: return 'leaf extensions: %s: %s' % (type(e).__name__, str(e)[:160])
    try:
        rs = [x509.load_der_x509_certificate(r) for r in roots]
        PolicyBuilder().store(Store(rs)).time(now).build_server_verifier(x509.DNSName(FQDN)).verify(cs[0], cs[1:])
    except Exception as e: return 'verify: %s: %s' % (type(e).__name__, str(e)[:200].split(' (encountered')[0])
    return 'ok'

cases = []
def add(label, chain, roots, note, now=NOW):
    value = {'certificatePem': ''.join(pem(c) for c in chain), 'privateKeyPem': keypem}
    try:
        meta = validate(value, FQDN, [x509.load_der_x509_certificate(r) for r in roots], now); acc = True
    except (ValueError, TypeError):
        meta = None; acc = False
    cases.append(dict(name=label, note=note, now=now.isoformat(), value=value, roots=''.join(pem(r) for r in roots),
                      python=acc, pythonReason=why(chain, roots, now), meta=meta))

L, I, R = der(leaf), der(inter), der(root)
add('control-valid', [L, I], [R], 'positive control')
add('control-rsa-intermediate', [der(rleaf), der(rinter)], [R], 'positive control RSA intermediate')
# --- BER/DER inside extension OCTET STRING values (leaf) ---
for ext in ['san', 'ku', 'bc', 'eku', 'ski', 'aki', 'aia', 'cp', 'crldp']:
    add('leaf-%s-inner-nonminimal-length' % ext, [resign(L, ik, ext_edit(ext, value_edit(lambda v: relen_outer(v, 'long')))), I], [R],
        'extnValue inner TLV uses non-minimal long-form length')
add('leaf-san-inner-indefinite', [resign(L, ik, ext_edit('san', value_edit(lambda v: indef(0x30, body(v))))), I], [R], 'SAN inner SEQUENCE indefinite length')
add('leaf-san-inner-trailing-byte', [resign(L, ik, ext_edit('san', value_edit(lambda v: v + b'\x00'))), I], [R], 'one trailing 0x00 after SAN SEQUENCE inside OCTET STRING')
add('leaf-san-inner-dnsname-nonminimal', [resign(L, ik, ext_edit('san', value_edit(lambda v: tlv(0x30, relen_outer(kids(v)[0], 'long'))))), I], [R], 'dNSName [2] uses long-form length 0x81')
# --- BOOLEAN / DEFAULT / BIT STRING DER rules ---
def crit_explicit_false(parts):
    assert len(parts) == 2; return [parts[0], b'\x01\x01\x00', parts[1]]
add('leaf-eku-critical-explicit-false', [resign(L, ik, ext_edit('eku', crit_explicit_false)), I], [R], 'critical BOOLEAN DEFAULT FALSE explicitly encoded')
def crit_true_01(parts):
    assert parts[1] == b'\x01\x01\xff'; return [parts[0], b'\x01\x01\x01', parts[2]]
add('leaf-ku-critical-true-0x01', [resign(L, ik, ext_edit('ku', crit_true_01)), I], [R], 'critical TRUE encoded as 0x01 (BER, not DER)')
add('leaf-bc-explicit-ca-false', [resign(L, ik, ext_edit('bc', value_edit(lambda v: bytes.fromhex('3003010100')))), I], [R], 'BasicConstraints cA DEFAULT FALSE explicitly encoded')
def ku_padding(v):
    assert v == bytes.fromhex('03020780'), v.hex(); return bytes.fromhex('03020781')
add('leaf-ku-nonzero-unused-bits', [resign(L, ik, ext_edit('ku', value_edit(ku_padding))), I], [R], 'KeyUsage BIT STRING unused bits not zero')
def constructed_octets(parts):
    inner = body(parts[-1]); parts[-1] = tlv(0x24, tlv(0x04, inner)); return parts
add('leaf-san-extnvalue-constructed-octet-string', [resign(L, ik, ext_edit('san', constructed_octets)), I], [R], 'extnValue OCTET STRING in constructed form')
# --- Name rules ---
def subject_edit(new):
    def edit(tbs): tbs[5] = new; return tbs
    return edit
cn = lambda s, t=0x0c: tlv(0x30, tlv(0x06, bytes.fromhex('550403')) + tlv(t, s.encode()))
o = lambda s, t=0x0c: tlv(0x30, tlv(0x06, bytes.fromhex('55040a')) + tlv(t, s.encode()))
add('leaf-subject-printablestring-invalid-char', [resign(L, ik, subject_edit(tlv(0x30, tlv(0x31, cn(FQDN)) + tlv(0x31, o('A_B*', 0x13))))), I], [R], 'PrintableString with _ and * in subject O')
pair = sorted([cn(FQDN), o('Org')])
add('leaf-subject-multivalued-rdn-unsorted', [resign(L, ik, subject_edit(tlv(0x30, tlv(0x31, pair[1] + pair[0])))), I], [R], 'multi-valued RDN SET OF not in DER order')
add('leaf-subject-multivalued-rdn-sorted', [resign(L, ik, subject_edit(tlv(0x30, tlv(0x31, pair[0] + pair[1])))), I], [R], 'control: multi-valued RDN in DER order')
# L-B Name structures with critical / noncritical SAN
for crit in [False, True]:
    tmpl = der(build(lk, '', 'Reviewer Intermediate', ik, san_critical=crit))
    add('name-empty-seq-%s' % crit, [tmpl, I], [R], 'subject SEQUENCE{} SAN critical=%s' % crit)
    add('name-cn-plus-empty-rdn-%s' % crit, [resign(tmpl, ik, subject_edit(tlv(0x30, tlv(0x31, cn(FQDN)) + tlv(0x31, b'')))), I], [R], 'subject {CN} {} SAN critical=%s' % crit)
    add('name-empty-cn-value-%s' % crit, [resign(tmpl, ik, subject_edit(tlv(0x30, tlv(0x31, cn(''))))), I], [R], 'subject CN="" SAN critical=%s' % crit)
    add('name-cn-%s' % crit, [resign(tmpl, ik, subject_edit(tlv(0x30, tlv(0x31, cn(FQDN))))), I], [R], 'subject CN SAN critical=%s' % crit)
# --- Time encodings ---
def validity_edit(nb=None, na=None):
    def edit(tbs):
        t = kids(tbs[4]); t = [nb if nb is not None else t[0], na if na is not None else t[1]]
        tbs[4] = tlv(0x30, b''.join(t)); return tbs
    return edit
na = (NOW + dt.timedelta(days=90)).strftime('%y%m%d%H%M%SZ').encode()
add('leaf-notafter-constructed-utctime', [resign(L, ik, validity_edit(na=tlv(0x37, tlv(0x04, na)))), I], [R], 'UTCTime in constructed form')
add('leaf-notbefore-generalized-year-0050', [resign(L, ik, validity_edit(nb=tlv(0x18, b'00500101000000Z'))), I], [R], 'GeneralizedTime year 0050 (outside 1950..2049)')
add('leaf-notafter-utctime-month-13', [resign(L, ik, validity_edit(na=tlv(0x17, b'261301000000Z'))), I], [R], 'UTCTime syntactically 12 digits but invalid month')
# --- Intermediate / anchor extension inner BER ---
for ext in ['ku', 'bc', 'aki']:
    add('intermediate-%s-inner-nonminimal-length' % ext, [L, resign(I, rk, ext_edit(ext, value_edit(lambda v: relen_outer(v, 'long'))))], [R], 'intermediate extnValue inner non-minimal length')
for ext in ['ku', 'bc']:
    add('anchor-%s-inner-nonminimal-length' % ext, [L, I], [resign(R, rk, ext_edit(ext, value_edit(lambda v: relen_outer(v, 'long'))))], 'anchor extnValue inner non-minimal length')
add('intermediate-eku-critical-explicit-false', [L, resign(I, rk, ext_edit('eku', crit_explicit_false))], [R], 'intermediate critical DEFAULT FALSE encoded')
# --- RSA issuer SPKI BIT STRING inner BER ---
def spki_edit(tbs):
    alg, bits = kids(tbs[6]); payload = body(bits)
    assert payload[0] == 0; inner = payload[1:]
    tbs[6] = tlv(0x30, alg + tlv(0x03, b'\x00' + relen_outer(inner, 'long'))); return tbs
add('rsa-intermediate-spki-inner-nonminimal-length', [der(rleaf), resign(der(rinter), rk, spki_edit)], [R], 'RSAPublicKey SEQUENCE inside SPKI BIT STRING non-minimal length')
# Role/selection boundaries: unknown bytes are not automatically DER, and an
# invalid CA candidate must not discard an otherwise valid alternative.
def append_extension(oid_hex, encoded):
    def edit(tbs):
        index=next(i for i,p in enumerate(tbs) if p[0]==0xa3)
        extensions=kids(kids(tbs[index])[0])
        extensions.append(tlv(0x30,tlv(6,bytes.fromhex(oid_hex))+tlv(4,encoded)))
        tbs[index]=tlv(0xa3,tlv(0x30,b''.join(extensions)));return tbs
    return edit
add('leaf-unknown-opaque-value', [resign(L,ik,append_extension('2a0304',b'\x00')),I],[R],'unknown noncritical extension stays opaque')
add('ca-ski-opaque-policy', [L,resign(I,rk,ext_edit('ski',value_edit(lambda v:relen_outer(v,'long'))))],[R],'default CA SKI validator has no content parser')
bad_inter=resign(I,rk,ext_edit('ku',value_edit(lambda v:relen_outer(v,'long'))))
bad_root=resign(R,rk,ext_edit('bc',value_edit(lambda v:relen_outer(v,'long'))))
add('alternate-ca-first-inner-ber', [L,bad_inter,I],[R],'skip malformed selected CA and try valid alternate')
add('alternate-anchor-first-inner-ber', [L,I],[bad_root,R],'anchor participates in policy, valid alternative remains')
for label,oid_hex,encoded in [
    ('tls-feature-valid','2b06010505070118',tlv(0x30,tlv(2,b'\x05'))),
    ('tls-feature-wrong-tag','2b06010505070118',tlv(2,b'\x05')),
    ('ocsp-nocheck-valid','2b0601050507300105',tlv(5,b'')),
    ('ocsp-nocheck-wrong-tag','2b0601050507300105',tlv(2,b'\x00')),
    ('sct-invalid-list','2b06010401d679020402',tlv(4,b'\x00')),
]:
    add('leaf-'+label,[resign(L,ik,append_extension(oid_hex,encoded)),I],[R],'known leaf extension payload boundary')
for label,tag,encoded in [('bmp-valid',30,'Example'.encode('utf-16be')),('bmp-odd',30,b'\x00'),('bmp-surrogate',30,b'\xd8\x00'),
                          ('universal-valid',28,'Example'.encode('utf-32be')),('universal-surrogate',28,b'\x00\x00\xd8\x00')]:
    subject=tlv(0x30,tlv(0x31,cn(FQDN))+tlv(0x31,tlv(0x30,tlv(6,bytes.fromhex('55040a'))+tlv(tag,encoded))))
    add('subject-'+label,[resign(L,ik,subject_edit(subject)),I],[R],'ASN.1 Name string content')
early_edit=validity_edit(nb=tlv(24,b'00500101000000Z'),na=tlv(24,b'00600101000000Z'))
add('generalized-early-century-metadata',[resign(L,ik,early_edit),resign(I,rk,early_edit)],[resign(R,rk,early_edit)],'year0050..0060 decoded without JS two-digit-year mapping',dt.datetime(55,1,1,tzinfo=dt.timezone.utc))
def vector(v): return len(v).to_bytes(2,'big')+v
def sct(hash_id=4,signature_id=3,extra=b''):
    entry=b'\x00'+b'\x01'*32+b'\x00'*8+vector(b'')+bytes([hash_id,signature_id])+vector(b'\x00')+extra
    return vector(vector(entry))
for label,data in [('sct-valid-framing',sct()),('sct-empty-list',vector(b'')),('sct-md5-metadata',sct(1,1)),
                   ('sct-hash-none',sct(0)),('sct-signature-anonymous',sct(4,0)),('sct-entry-trailing',sct(extra=b'\x00')),
                   ('sct-outer-trailing',sct()+b'\x00')]:
    add('leaf-'+label,[resign(L,ik,append_extension('2b06010401d679020402',tlv(4,data))),I],[R],
        'SCT parsing is framing/algorithm metadata, not CT-log signature validation')
for label,oid_hex,encoded in [
    ('ms-template-valid','2b0601040182371507',tlv(48,tlv(6,b'\x2a\x03'))),
    ('ms-template-invalid','2b0601040182371507',tlv(48,tlv(2,b'\x00'))),
    ('admissions-valid','2b24080303',tlv(48,tlv(48,b''))),
    ('admissions-invalid','2b24080303',tlv(48,tlv(2,b'\x00'))),
]:
    add('leaf-'+label,[resign(L,ik,append_extension(oid_hex,encoded)),I],[R],'known extension type structure, not just outer tag')
naming=tlv(48,tlv(6,b'\x2a\x03')+tlv(22,b'http://authority.example/')+tlv(12,b'Authority'))
profession=tlv(48,tlv(160,naming)+tlv(48,tlv(12,b'Engineer'))+tlv(48,tlv(6,b'\x2a\x03'))+tlv(19,b'12345')+tlv(4,b'\xff'))
admission=tlv(48,tlv(160,tlv(134,b'http://admission.example/'))+tlv(161,naming)+tlv(48,profession))
add('leaf-admissions-profession-valid',[resign(L,ik,append_extension('2b24080303',tlv(48,tlv(134,b'http://admission.example/')+tlv(48,admission)))),I],[R],'all optional Admissions fields; additional profession info remains opaque')
bad_admission=tlv(48,tlv(48,tlv(48,tlv(2,b'\x00'))))
add('leaf-admissions-profession-invalid',[resign(L,ik,append_extension('2b24080303',tlv(48,tlv(48,bad_admission)))),I],[R],'professionItems must be a SEQUENCE of DisplayText')
# Import/public-key equality is insufficient for private RSA/EC consistency.
def positive_integer(n):
    data=n.to_bytes(max(1,(n.bit_length()+7)//8),'big')
    return tlv(2,(b'\x00' if data[0]&128 else b'')+data)
def private_pem(label,raw):return '-----BEGIN '+label+'-----\n'+base64.encodebytes(raw).decode()+'-----END '+label+'-----\n'
def add_private(label,chain,private):
    value={'certificatePem':''.join(pem(c) for c in chain),'privateKeyPem':private}
    try:meta=validate(value,FQDN,[root],NOW);accepted=True
    except (ValueError,TypeError):meta=None;accepted=False
    cases.append(dict(name=label,note='disposable inconsistent private-key fixture',now=NOW.isoformat(),value=value,roots=pem(R),python=accepted,pythonReason='ok' if accepted else 'private-key validation rejected',meta=meta))
rsa_leaf=der(build(rsa_ik,FQDN,'Reviewer Root',rk))
numbers=rsa_ik.private_numbers();other=rsa.generate_private_key(public_exponent=65537,key_size=2048).private_numbers()
add_private('leaf-private-rsa-valid',[rsa_leaf],rsa_ik.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode())
for label,attr in [('d','d'),('p','p'),('q','q'),('dp','dmp1'),('dq','dmq1'),('qi','iqmp')]:
    parts={n:getattr(numbers,n) for n in ['d','p','q','dmp1','dmq1','iqmp']};parts[attr]=getattr(other,attr)
    raw=tlv(48,b''.join(positive_integer(n) for n in [0,numbers.public_numbers.n,numbers.public_numbers.e,*[parts[k] for k in ['d','p','q','dmp1','dmq1','iqmp']]]))
    add_private('leaf-private-rsa-corrupt-'+label,[rsa_leaf],private_pem('RSA PRIVATE KEY',raw))
wrong_scalar=ec.generate_private_key(ec.SECP256R1()).private_numbers().private_value.to_bytes(32,'big')
point=lk.public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)
sec1=tlv(48,positive_integer(1)+tlv(4,wrong_scalar)+tlv(160,tlv(6,bytes.fromhex('2a8648ce3d030107')))+tlv(161,tlv(3,b'\x00'+point)))
add_private('leaf-private-ec-scalar-mismatch',[L,I],private_pem('EC PRIVATE KEY',sec1))
expected_true={'control-valid','control-rsa-intermediate','leaf-subject-multivalued-rdn-sorted','name-cn-plus-empty-rdn-False','name-empty-cn-value-False','name-cn-False','name-empty-seq-True','leaf-notbefore-generalized-year-0050'}
expected_true.update(['leaf-unknown-opaque-value','ca-ski-opaque-policy','alternate-ca-first-inner-ber','alternate-anchor-first-inner-ber',
                      'leaf-tls-feature-valid','leaf-ocsp-nocheck-valid','subject-bmp-valid','subject-universal-valid','generalized-early-century-metadata'])
expected_true.update(['leaf-sct-valid-framing','leaf-sct-empty-list','leaf-sct-md5-metadata'])
expected_true.update(['leaf-ms-template-valid','leaf-admissions-valid'])
expected_true.add('leaf-admissions-profession-valid')
expected_true.add('leaf-private-rsa-valid')
for c in cases:
    c['accepted']=c.pop('python');c['expected']=c['name'] in expected_true
    assert c['accepted']==c['expected'], c['name']
json.dump(dict(fqdn=FQDN, cases=cases), open(OUT, 'w'))
for c in cases: print(json.dumps({'name': c['name'], 'python': c['accepted'], 'reason': c['pythonReason']}))
