"""Development-only certificate corpus and current Python verification oracle."""
import sys,json,ipaddress
from pathlib import Path
from datetime import datetime,timedelta,timezone
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from certificate import validate
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID,ObjectIdentifier
NOW=datetime(2026,10,17,tzinfo=timezone.utc)
FQDN='notifications.example.com'
pem=lambda c:c.public_bytes(serialization.Encoding.PEM).decode()
keypem=lambda k:k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
def key():return ec.generate_private_key(ec.SECP256R1())
def cert(k,issuer,ik,ca=False,path=None,names=None,eku=True,ku=True,days=90,future=False,critical=False,constraints=None,subject=None,missing=None,sancritical=False):
 name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,subject or ('CA' if ca else FQDN))])
 b=x509.CertificateBuilder().subject_name(name).issuer_name(issuer or name).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(NOW+timedelta(days=1) if future else NOW-timedelta(days=3)).not_valid_after(NOW+timedelta(days=days))
 if missing!='bc':b=b.add_extension(x509.BasicConstraints(ca,path),True)
 b=b.add_extension(x509.SubjectKeyIdentifier.from_public_key(k.public_key()),False)
 if missing!='aki':b=b.add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ik.public_key()),False)
 if ku is not None:b=b.add_extension(x509.KeyUsage(not ca if ku else False,False,False,False,False,(ca or ku=='ca') if ku else False,ca if ku else False,False,False),True)
 if not ca and eku is not None:b=b.add_extension(x509.ExtendedKeyUsage([ObjectIdentifier('2.5.29.37.0') if eku=='any' else (ExtendedKeyUsageOID.SERVER_AUTH if eku else ExtendedKeyUsageOID.CLIENT_AUTH)]),False)
 if names is not None:b=b.add_extension(x509.SubjectAlternativeName(names),sancritical)
 if critical:b=b.add_extension(x509.UnrecognizedExtension(ObjectIdentifier('1.2.3.4.987'),b'\x05\x00'),True)
 if constraints:b=b.add_extension(constraints,True)
 return b.sign(ik,hashes.SHA256())
results=[]
for kind in ['valid','extra-san','ip-san','uri-san','duplicate-san','cn-only','wildcard','wrong-san','wrong-key','expired','future','eku-client','eku-missing','ku-empty','ku-missing','unknown-critical','wrong-root','staging-as-public','signature','malformed','intermediate-valid','intermediate-expired','intermediate-future','intermediate-not-ca','pathlen','nameconstraint','leaf-ca','expired-root','eku-any','ku-keycertsign','san-critical','missing-aki','missing-bc','unrelated-intermediate','unrelated-root','ordinary-intermediate','notafter-boundary','notbefore-boundary']:
 rk=key();root=cert(rk,None,rk,True,path=0 if kind=='pathlen' else 2,days=-1 if kind=='expired-root' else 365)
 ik=rk;issuer=root;chain=[]
 if kind.startswith('intermediate-') or kind in ['pathlen','nameconstraint','ordinary-intermediate','unrelated-intermediate']:
  ik=key();issuer=cert(ik,root.subject,rk,kind!='intermediate-not-ca',days=-1 if kind=='intermediate-expired' else 90,future=kind=='intermediate-future',subject='Intermediate CA' if kind in ['ordinary-intermediate','unrelated-intermediate'] else None,constraints=x509.NameConstraints([x509.DNSName('other.example.org')],None) if kind=='nameconstraint' else None);chain=[issuer]
 names=[x509.DNSName(FQDN)]
 if kind=='extra-san':names+=[x509.DNSName('other.example.com')]
 if kind=='ip-san':names+=[x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]
 if kind=='uri-san':names+=[x509.UniformResourceIdentifier('https://example.com')]
 if kind=='duplicate-san':names*=2
 if kind=='cn-only':names=None
 if kind=='wildcard':names=[x509.DNSName('*.example.com')]
 if kind=='wrong-san':names=[x509.DNSName('wrong.example.com')]
 lk=key();leaf=cert(lk,issuer.subject,ik,ca=kind=='leaf-ca',names=names,eku=None if kind=='eku-missing' else ('any' if kind=='eku-any' else kind!='eku-client'),ku=None if kind=='ku-missing' else ('ca' if kind=='ku-keycertsign' else kind!='ku-empty'),days=-1 if kind=='expired' else 30,future=kind=='future',critical=kind=='unknown-critical',missing='aki' if kind=='missing-aki' else ('bc' if kind=='missing-bc' else None),sancritical=kind=='san-critical')
 if kind=='unrelated-intermediate':chain.append(cert(key(),None,key(),True))
 bundle=pem(leaf)+''.join(map(pem,chain))
 if kind=='signature':
  der=bytearray(leaf.public_bytes(serialization.Encoding.DER));der[-1]^=1;bundle=pem(x509.load_der_x509_certificate(bytes(der)))
 if kind=='malformed':bundle='fixture-secret-malformed'
 roots=[root]
 if kind in ['wrong-root','staging-as-public']:roots=[cert(key(),None,key(),True)]
 if kind=='unrelated-root':roots.append(cert(key(),None,key(),True))
 checktime=leaf.not_valid_after_utc if kind=='notafter-boundary' else (leaf.not_valid_before_utc if kind=='notbefore-boundary' else NOW)
 value={'certificatePem':bundle,'privateKeyPem':keypem(key() if kind=='wrong-key' else lk)}
 try:meta=validate(value,FQDN,roots,checktime);accepted=True
 except ValueError:meta=None;accepted=False
 expected=kind in ['valid','intermediate-valid','ku-missing','eku-missing','ku-empty','missing-bc','unrelated-intermediate','unrelated-root','ordinary-intermediate','notafter-boundary','notbefore-boundary']
 results.append({'name':kind,'now':checktime.isoformat(),'value':value,'roots':''.join(map(pem,roots)),'accepted':accepted,'expected':expected,'meta':meta})
print(json.dumps({'fqdn':FQDN,'now':NOW.isoformat(),'cases':results}))
