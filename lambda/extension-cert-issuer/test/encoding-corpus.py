"""Development-only DER/basic-policy boundary corpus; disposable EC keys only."""
import sys, json, base64, datetime as dt
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from certificate import validate
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

NOW = dt.datetime(2026, 10, 17, tzinfo=dt.timezone.utc)
FQDN = 'notifications.example.com'
def tlv(tag, body, ber=False):
    n = len(body); size = n.to_bytes(max(1, (n.bit_length()+7)//8), 'big')
    return bytes([tag]) + (bytes([n]) if n < 128 and not ber else bytes([128+len(size)])+size) + body
def children(raw):
    def end(p):
        n=raw[p+1]; s=p+2
        if n & 128:
            count=n & 127; n=int.from_bytes(raw[s:s+count], 'big'); s+=count
        return s,s+n
    start,stop=end(0); result=[]
    while start < stop:
        _,e=end(start); result.append(raw[start:e]); start=e
    return result
def pem(raw):
    return '-----BEGIN CERTIFICATE-----\n'+base64.encodebytes(raw).decode()+'-----END CERTIFICATE-----\n'
def der(c): return c.public_bytes(serialization.Encoding.DER)
def build(key, subject, issuer, signer, ca=False, critical=False, now=NOW):
    name=lambda s:x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,s)]) if s else x509.Name([])
    b=(x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer)).public_key(key.public_key())
       .serial_number(123).not_valid_before(now-dt.timedelta(days=3)).not_valid_after(now+dt.timedelta(days=365)))
    for ext,crit in [(x509.BasicConstraints(ca,None),True),(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),False),
                     (x509.AuthorityKeyIdentifier.from_issuer_public_key(signer.public_key()),False),
                     (x509.KeyUsage(not ca,False,False,False,False,ca,ca,False,False),True)]: b=b.add_extension(ext,crit)
    if not ca:
        b=b.add_extension(x509.SubjectAlternativeName([x509.DNSName(FQDN)]),critical)
        b=b.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),False)
    return b.sign(signer,hashes.SHA256())
def mutate(c, signer, edit):
    outer=children(der(c)); tbs=tlv(0x30,b''.join(edit(children(outer[0]))))
    return tlv(0x30,tbs+outer[1]+tlv(3,b'\x00'+signer.sign(tbs,ec.ECDSA(hashes.SHA256()))))
def field(index, raw):
    def edit(parts): parts[index]=raw; return parts
    return edit
rk=ec.generate_private_key(ec.SECP256R1()); ik=ec.generate_private_key(ec.SECP256R1()); lk=ec.generate_private_key(ec.SECP256R1())
root=build(rk,'Encoding Root','Encoding Root',rk,True)
inter=build(ik,'Encoding Intermediate','Encoding Root',rk,True)
leaf=build(lk,FQDN,'Encoding Intermediate',ik)
cases=[]
def add(label, chain, roots, expected, now=NOW):
    value={'certificatePem':''.join(pem(c) for c in chain),'privateKeyPem':lk.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()}
    try:
        meta=validate(value,FQDN,[x509.load_der_x509_certificate(c) for c in roots],now); accepted=True
    except (ValueError,TypeError): meta=None; accepted=False
    assert accepted == expected, (label,accepted,expected)
    cases.append(dict(name=label,now=now.isoformat(),value=value,roots=''.join(pem(c) for c in roots),accepted=accepted,expected=expected,meta=meta))
serials=[('zero',b'\x00',True),('one',b'\x01',True),('20-octets',b'\x01'*20,True),
         ('21-sign-octets',b'\x00'+b'\x81'*20,True),('21-value-octets',b'\x01'*21,True),
         ('22-octets',b'\x01'*22,False),('negative',b'\xfb',False),('redundant-zero',b'\x00\x01',False)]
for location,template,signer in [('leaf',leaf,ik),('intermediate',inter,rk),('anchor',root,rk)]:
    edits=[('serial-'+label,field(1,tlv(2,value)),ok) for label,value,ok in serials]
    def ber(parts): parts[4]=tlv(0x30,b''.join(children(parts[4])),True); return parts
    def generalized(parts):
        times=children(parts[4]); times[1]=tlv(0x18,(NOW+dt.timedelta(days=365)).strftime('%Y%m%d%H%M%SZ').encode())
        parts[4]=tlv(0x30,b''.join(times)); return parts
    edits += [('ber-validity',ber,False),('generalized-before-2050',generalized,False)]
    for label,edit,ok in edits:
        changed=mutate(template,signer,edit)
        chain=[changed if location=='leaf' else der(leaf),changed if location=='intermediate' else der(inter)]
        add(location+'-'+label,chain,[changed if location=='anchor' else der(root)],ok)
for critical in [False,True]:
    template=build(lk,'', 'Encoding Intermediate',ik,critical=critical)
    add('empty-subject-'+str(critical),[der(template),der(inter)],[der(root)],critical)
    for count in [1,2]:
        add('empty-rdn-'+str(count)+'-'+str(critical),[mutate(template,ik,field(5,tlv(0x30,tlv(0x31,b'')*count))),der(inter)],[der(root)],not critical)
        # Retain OpenSSL's stronger rejection of malformed empty RDNs even without critical SAN.
        if not critical: cases[-1]['tsExpected']=False
future=dt.datetime(2050,1,2,tzinfo=dt.timezone.utc)
fr=build(rk,'Future Root','Future Root',rk,True,now=future)
fl=build(lk,FQDN,'Future Root',rk,now=future)
add('utc-2049-generalized-2050-valid',[der(fl)],[der(fr)],True,future)
print(json.dumps(dict(fqdn=FQDN,now=NOW.isoformat(),cases=cases)))
