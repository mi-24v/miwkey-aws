/** Public-root path verification; private keys never leave memory. */
import {X509Certificate as NativeCertificate, createPrivateKey, KeyObject} from 'node:crypto';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {AsnParser,AsnSerializer} from '@peculiar/asn1-schema';
import {Certificate} from '@peculiar/asn1-x509';
import * as pkix from '@peculiar/asn1-x509';
import {X509Certificate, SubjectAlternativeNameExtension, BasicConstraintsExtension, ExtensionFactory} from '@peculiar/x509';
const execute = promisify(execFile);
export interface Bundle {certificatePem: string; privateKeyPem: string}
export interface Metadata {fingerprint: string; notAfter: string}
/** Import/public-key equality does not prove private component consistency. */
export function assertValidPrivateKey(key:KeyObject):void {
  try{
    execFileSync('/usr/bin/openssl',['pkey','-check','-noout'],{input:key.export({type:'pkcs8',format:'pem'}),timeout:5000,maxBuffer:8192,
      stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',OPENSSL_CONF:'/dev/null'}});
  }catch{throw new Error('private key validation failed');}
}
export function metadata(value: Bundle): Metadata {
  const c = new NativeCertificate(certificates(value.certificatePem,true)[0]);
  return {fingerprint: c.fingerprint256.replace(/:/g, '').toLowerCase(), notAfter: timeValue(certificateFields(c.raw).validity.children[1]).date.toISOString().replace('.000Z', 'Z')};
}
interface DerValue {tag:number;full:Buffer;content:Buffer;children:DerValue[]}
/** Canonical DER content as well as lengths. OCTET/BIT STRING payloads stay opaque here. */
function strictDer(data:Buffer,start=0,end=data.length):DerValue[] {
  const values:DerValue[]=[];
  let p=start;
  while(p<end){
    const begin=p;
    const tag=data[p++];
    if((tag&31)===31){
      if(p>=end||data[p]===0x80||data[p]<31)throw new Error();
      while(p<end&&(data[p++]&128)){};
    }
    if(p>=end)throw new Error();
    let length=data[p++];
    if(length&128){
      const count=length&127;
      if(!count||count>4||p+count>end||data[p]===0)throw new Error();
      length=0;for(let n=0;n<count;n++)length=length*256+data[p++];
      if(length<128)throw new Error();
    }
    const stop=p+length;if(stop>end)throw new Error();
    const content=data.subarray(p,stop),children=(tag&32)?strictDer(data,p,stop):[];
    if((tag&0xc0)===0){
      const number=tag&31;
      if(number===0||((tag&32)&&[1,2,3,4,5,6,10,12,18,19,20,21,22,23,24,25,26,27,28,30].includes(number))||(!(tag&32)&&[16,17].includes(number)))throw new Error();
    }
    if(tag===1&&(length!==1||![0,255].includes(content[0])))throw new Error();
    if((tag===2||tag===10)&&(!length||(length>1&&((content[0]===0&&!(content[1]&128))||(content[0]===255&&(content[1]&128))))))throw new Error();
    if(tag===3&&(!length||content[0]>7||(length===1&&content[0]!==0)||(length>1&&(content[length-1]&((1<<content[0])-1)))))throw new Error();
    if(tag===5&&length!==0)throw new Error();
    if(tag===6){
      if(!length||length>63||(content[length-1]&128))throw new Error();
      let arc=0n;for(const byte of content){arc=(arc<<7n)|BigInt(byte&127);if(arc>=(1n<<128n))throw new Error();if(!(byte&128))arc=0n;}
      for(let i=0;i<length;i++)if((i===0||!(content[i-1]&128))&&content[i]===128)throw new Error();
    }
    if(tag===19&&!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(content.toString('latin1')))throw new Error();
    if(tag===30){
      if(length%2)throw new Error();
      new TextDecoder('utf-16be',{fatal:true}).decode(content);
    }
    if(tag===28){
      if(length%4)throw new Error();
      for(let i=0;i<length;i+=4){const code=content.readUInt32BE(i);if(code>0x10ffff||(code>=0xd800&&code<=0xdfff))throw new Error();}
    }
    if(tag===49){
      for(let i=1;i<children.length;i++)if(children[i-1].full.compare(children[i].full)>0)throw new Error();
    }
    values.push({tag,full:data.subarray(begin,stop),content,children});
    p=stop;
  }
  if(p!==end)throw new Error();
  return values;
}
function singleDer(data:Buffer):DerValue {
  const values=strictDer(data);if(values.length!==1)throw new Error();return values[0];
}
/** Retag a known implicit primitive; never guess at arbitrary context payloads. */
function implicit(value:DerValue,tag:number):DerValue {
  return singleDer(Buffer.concat([Buffer.from([tag]),value.full.subarray(1)]));
}
const parameterlessAlgorithms=new Set(["1.3.101.112", "1.3.101.113", "2.16.840.1.101.3.4.3.17", "2.16.840.1.101.3.4.3.18", "2.16.840.1.101.3.4.3.19", "1.3.101.110", "1.3.101.111", "2.16.840.1.101.3.4.4.2", "2.16.840.1.101.3.4.4.3", "1.3.6.1.5.5.7.6.36", "1.2.840.10045.4.3.1", "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4", "2.16.840.1.101.3.4.3.9", "2.16.840.1.101.3.4.3.10", "2.16.840.1.101.3.4.3.11", "2.16.840.1.101.3.4.3.12", "2.16.840.1.101.3.4.3.1", "2.16.840.1.101.3.4.3.2", "2.16.840.1.101.3.4.3.3", "2.16.840.1.101.3.4.3.4"]);
const optionalNullAlgorithms=new Set(["1.3.14.3.2.26", "2.16.840.1.101.3.4.2.4", "2.16.840.1.101.3.4.2.1", "2.16.840.1.101.3.4.2.2", "2.16.840.1.101.3.4.2.3", "1.3.6.1.4.1.37476.3.2.1.99.7.224", "1.3.6.1.4.1.37476.3.2.1.99.7.256", "1.3.6.1.4.1.37476.3.2.1.99.7.384", "1.3.6.1.4.1.37476.3.2.1.99.7.512", "2.16.840.1.101.3.4.2.7", "2.16.840.1.101.3.4.2.8", "2.16.840.1.101.3.4.2.9", "2.16.840.1.101.3.4.2.10", "1.2.840.113549.1.1.1", "1.2.840.113549.1.1.5", "1.3.14.3.2.29", "1.2.840.113549.1.1.14", "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13", "2.16.840.1.101.3.4.3.13", "2.16.840.1.101.3.4.3.14", "2.16.840.1.101.3.4.3.15", "2.16.840.1.101.3.4.3.16", "1.2.840.113549.2.7", "1.2.840.113549.2.8", "1.2.840.113549.2.9", "1.2.840.113549.2.10", "1.2.840.113549.2.11"]);
/** Match the field's declared Rust ASN.1 unsigned type, not a blanket integer cap. */
function unsigned(value:DerValue,bits?:number):bigint {
  if(value.tag!==2||!value.content.length||(value.content[0]&128))throw new Error();
  let result=0n;for(const byte of value.content)result=(result<<8n)|BigInt(byte);
  if(bits!==undefined&&result>=(1n<<BigInt(bits)))throw new Error();return result;
}
function checkAlgorithm(value:DerValue):void {
  const alg=AsnParser.parse(value.full,pkix.AlgorithmIdentifier),parts=value.children;
  if(value.tag!==48||parts.length<1||parts.length>2)throw new Error();
  if(parameterlessAlgorithms.has(alg.algorithm)&&parts.length!==1)throw new Error();
  if(optionalNullAlgorithms.has(alg.algorithm)&&parts[1]&&parts[1].tag!==5)throw new Error();
  const params=parts[1];
  const ivSize:Record<string,number>={'2.16.840.1.101.3.4.1.2':16,'2.16.840.1.101.3.4.1.22':16,
    '2.16.840.1.101.3.4.1.42':16,'1.2.840.113549.3.7':8};
  if(ivSize[alg.algorithm]&&(params?.tag!==4||params.content.length!==ivSize[alg.algorithm]))throw new Error();
  const pbe=new Set(['1.2.840.113549.1.5.3','1.2.840.113549.1.12.1.1','1.2.840.113549.1.12.1.3','1.2.840.113549.1.12.1.6']);
  if(pbe.has(alg.algorithm)){
    if(params?.tag!==48||params.children.length!==2||params.children[0].tag!==4)throw new Error();
    if(alg.algorithm==='1.2.840.113549.1.5.3'&&params.children[0].content.length!==8)throw new Error();
    unsigned(params.children[1],64);
  }
  if(alg.algorithm==='1.2.840.113549.3.2'){
    if(params?.tag!==48)throw new Error();const fields=params.children;let i=0;
    if(fields[i]?.tag===2)unsigned(fields[i++],32);
    if(fields[i]?.tag!==4||fields[i].content.length!==8||++i!==fields.length)throw new Error();
  }
  if(alg.algorithm==='1.2.840.113549.1.5.13'){
    if(params?.tag!==48||params.children.length!==2)throw new Error();params.children.forEach(checkAlgorithm);
  }
  if(alg.algorithm==='1.2.840.113549.1.5.12'){
    if(params?.tag!==48)throw new Error();const fields=params.children;let i=2;
    if(fields.length<2||fields[0].tag!==4)throw new Error();unsigned(fields[1],64);
    if(fields[i]?.tag===2)unsigned(fields[i++],64);
    if(fields[i]){
      checkAlgorithm(fields[i]);if(fields[i++].full.toString('hex')==='300c06082a864886f70d02070500')throw new Error();
    }
    if(i!==fields.length)throw new Error();
  }
  if(alg.algorithm==='1.3.6.1.4.1.11591.4.11'){
    if(params?.tag!==48)throw new Error();const fields=params.children;
    if(fields.length<4||fields.length>5||fields[0].tag!==4)throw new Error();
    fields.slice(1,4).forEach(v=>unsigned(v,64));if(fields[4])unsigned(fields[4],32);
  }
  if(['1.2.840.10040.4.1','1.2.840.113549.1.3.1','1.2.840.10046.2.1'].includes(alg.algorithm)){
    if(params?.tag!==48)throw new Error();const fields=params.children;
    if(alg.algorithm==='1.2.840.10040.4.1'){
      if(fields.length!==3)throw new Error();fields.forEach(v=>unsigned(v));
    }else if(alg.algorithm==='1.2.840.113549.1.3.1'){
      if(fields.length<2||fields.length>3)throw new Error();fields.slice(0,2).forEach(v=>unsigned(v));
      if(fields[2])unsigned(fields[2],32);
    }else{
      if(fields.length<3||fields.length>5)throw new Error();fields.slice(0,3).forEach(v=>unsigned(v));
      let i=3;if(fields[i]?.tag===2)unsigned(fields[i++]);
      if(fields[i]?.tag===48)i++;if(i!==fields.length)throw new Error();
    }
  }
  if(alg.algorithm==='1.2.840.10045.2.1'){
    if(!params||![5,6,48].includes(params.tag))throw new Error();
    if(params.tag===48){
      const fields=params.children;if(fields.length<5||fields.length>6)throw new Error();
      unsigned(fields[0],8);
      const [field,curve]=fields.slice(1,3);
      if(field.tag!==48||field.children.length!==2||field.children[0].tag!==6)throw new Error();
      const type=field.children[0].content.toString('hex');
      if(type==='2a8648ce3d0101')unsigned(field.children[1]);
      else if(type!=='2a8648ce3d0102'||field.children[1].tag!==48)throw new Error();
      if(curve.tag!==48||curve.children.length<2||curve.children.length>3||curve.children[0].tag!==4||curve.children[1].tag!==4||(curve.children[2]&&curve.children[2].tag!==3))throw new Error();
      if(fields[3].tag!==4)throw new Error();unsigned(fields[4]);if(fields[5])unsigned(fields[5],8);
    }
  }
  if(alg.algorithm==='1.2.840.113549.1.1.10'&&parts[1]){
    if(parts[1].tag!==48)throw new Error();let previous=159;
    for(const field of parts[1].children){
      if(field.tag<160||field.tag>163||field.tag<=previous||field.children.length!==1)throw new Error();previous=field.tag;
      const child=field.children[0];
      if(field.tag===160){
        checkAlgorithm(child);if(child.full.toString('hex')==='300906052b0e03021a0500')throw new Error();
      }else if(field.tag===161){
        if(child.tag!==48||child.children.length!==2||child.children[0].tag!==6)throw new Error();
        checkAlgorithm(child.children[1]);
        if(child.children[0].content.toString('hex')==='2a864886f70d010108'&&child.children[1].full.toString('hex')==='300906052b0e03021a0500')throw new Error();
      }else if(field.tag===162){if(unsigned(child,16)===20n)throw new Error();}
      else unsigned(child,8); // Explicit trailer=1 is accepted by the oracle despite the RFC DEFAULT.
    }
  }
}
function displayText(value:DerValue):void {
  if(![12,22,26,30].includes(value.tag))throw new Error();
  if(value.tag===22&&value.content.some(b=>b>127))throw new Error();
  if([12,26].includes(value.tag))new TextDecoder('utf-8',{fatal:true}).decode(value.content);
}
/** Name attributes are objectified only for known leaf extension values. */
function objectRdn(value:DerValue):void {
  if(value.tag!==49||!value.children.length)throw new Error();
  const seen=new Set<string>();
  for(const attribute of value.children){
    if(attribute.tag!==48||attribute.children.length!==2||attribute.children[0].tag!==6)throw new Error();
    const [oid,data]=attribute.children;
    if(![3,4,12,18,19,20,22,23,24,26,28,30].includes(data.tag))throw new Error();
    let decoded:string;
    if(data.tag===3){
      if(oid.content.toString('hex')!=='55042d')throw new Error();
      decoded='bytes:'+data.content.toString('hex');
    }else if(data.tag===28){
      decoded='text:';for(let i=0;i<data.content.length;i+=4)decoded+=String.fromCodePoint(data.content.readUInt32BE(i));
    }else{
      decoded='text:'+new TextDecoder(data.tag===30?'utf-16be':'utf-8',{fatal:true,ignoreBOM:true}).decode(data.content);
    }
    const key=JSON.stringify([oid.content.toString('hex'),decoded]);
    if(seen.has(key))throw new Error();seen.add(key);
  }
}
function generalName(value:DerValue,objects=false):void {
  AsnParser.parse(value.full,pkix.GeneralName);
  if([129,130,134].includes(value.tag))new TextDecoder('utf-8',{fatal:true}).decode(value.content);
  if(value.tag===136)implicit(value,6);
  if(objects&&value.tag===164){
    if(value.children.length!==1||value.children[0].tag!==48)throw new Error();
    value.children[0].children.forEach(objectRdn);
  }
  if(objects&&value.tag===135){
    const bytes=value.content;if(![4,8,16,32].includes(bytes.length))throw new Error();
    if([8,32].includes(bytes.length)){
      const half=bytes.length/2;let zero=false;
      for(let i=0;i<half;i++){
        const mask=bytes[i+half];if(bytes[i]&(~mask&255))throw new Error();
        for(let bit=7;bit>=0;bit--){if(mask&(1<<bit)){if(zero)throw new Error();}else zero=true;}
      }
    }
  }
}
function policyQualifiers(value:DerValue):void {
  for(const policy of value.children)for(const q of policy.children[1]?.children||[]){
    if(q.tag!==48||q.children.length!==2)throw new Error();
    const [id,qualifier]=q.children;
    // Decode a single OID via its known DER bytes; avoid an Any-valued qualifier.
    const expected=qualifier.tag===22?'2b06010505070201':qualifier.tag===48?'2b06010505070202':'';
    if(!expected||id.content.toString('hex')!==expected)throw new Error();
    if(qualifier.tag===22){displayText(qualifier);continue;}
    let i=0;const fields=qualifier.children;
    if(fields[0]?.tag===48){
      const ref=fields[i++];if(ref.children.length!==2||ref.children[1].tag!==48)throw new Error();
      displayText(ref.children[0]);for(const number of ref.children[1].children)if(number.tag!==2||(number.content[0]&128))throw new Error();
    }
    if(fields[i])displayText(fields[i++]);if(i!==fields.length)throw new Error();
  }
}
function timeValue(value:DerValue):{year:number;date:Date} {
  const text=value.content.toString('latin1');
  if(!(value.tag===23?/^\d{12}Z$/:value.tag===24?/^\d{14}Z$/:/^$/).test(text)||![23,24].includes(value.tag))throw new Error();
  const year=value.tag===24?Number(text.slice(0,4)):Number(text.slice(0,2))+(Number(text.slice(0,2))<50?2000:1900);
  const tail=text.slice(value.tag===24?4:2),iso=String(year).padStart(4,'0')+'-'+tail.slice(0,2)+'-'+tail.slice(2,4)+'T'+tail.slice(4,6)+':'+tail.slice(6,8)+':'+tail.slice(8,10)+'.000Z';
  const date=new Date(iso);if(!Number.isFinite(date.getTime())||date.toISOString()!==iso)throw new Error();
  return {year,date};
}
function certificateFields(der:Buffer):{spki:DerValue;validity:DerValue;extensions:DerValue[];issuer:DerValue;subject:DerValue} {
  const root=singleDer(der),tbs=root.children[0],fields=tbs.children;
  const offset=fields[0].tag===160?1:0;
  if(offset&&(fields[0].children.length!==1||fields[0].children[0].tag!==2||!fields[0].children[0].content.equals(Buffer.from([2]))))throw new Error(); // Only v1 (omitted DEFAULT) or v3 load successfully.
  [fields[offset+1],root.children[1],fields[offset+5].children[0]].forEach(checkAlgorithm);
  for(const field of fields)if([129,130].includes(field.tag))implicit(field,3);
  const validity=fields[offset+3];if(validity.children.length!==2)throw new Error();validity.children.forEach(timeValue);
  const extensions=fields.find(v=>v.tag===163)?.children[0]?.children||[];
  for(const ext of extensions){
    if(ext.children.length<2||ext.children.length>3||ext.children[0].tag!==6||ext.children.at(-1)?.tag!==4)throw new Error();
    // Extension.critical DEFAULT FALSE must be absent, not encoded as FALSE.
    if(ext.children.length===3&&(ext.children[1].tag!==1||ext.children[1].content[0]!==255))throw new Error();
  }
  return {spki:fields[offset+5],validity,extensions,issuer:fields[offset+2],subject:fields[offset+4]};
}
/** Compare canonical OID bytes; dotted strings can round arcs above 2^53. */
function duplicateExtensions(der:Buffer):boolean {
  const ids=certificateFields(der).extensions.map(e=>e.children[0].content.toString('hex'));
  return new Set(ids).size!==ids.length;
}
/** Preserve original extension identifiers when constructing typed library objects. */
function libraryExtensions(der:Buffer) {
  return certificateFields(der).extensions.map(e=>ExtensionFactory.create(Uint8Array.from(e.full)));
}
function certificates(pem: string, payload=false): string[] {
  const pattern=/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g;
  const matches=[...pem.matchAll(pattern)];
  // Payloads contain only standard certificate blocks. Trust bundles may contain comments.
  if(!matches.length||(payload&&pem.replace(pattern,'').trim()))throw new Error();
  for(const match of matches){
    const der=Buffer.from(match[1].replace(/\s/g,''),'base64');
    if(!der.equals(new NativeCertificate(der).raw))throw new Error();
    certificateFields(der);
  }
  return matches.map(m=>m[0]);
}
/** cryptography permits_basic applies to the selected path, including its anchor. */
function permittedBasic(pem:string):boolean {
  const cert=AsnParser.parse(new NativeCertificate(pem).raw,Certificate),tbs=cert.tbsCertificate;
  const serial=new Uint8Array(tbs.serialNumber);
  if(tbs.version!==2||!serial.length||serial.length>21||(serial[0]&128)||!tbs.issuer.length)return false;
  const root=singleDer(new NativeCertificate(pem).raw),fields=root.children[0].children;
  if(!root.children[1].full.equals(fields[fields[0].tag===160?2:1].full))return false; // Reserialization can truncate large OID arcs.
  for(const time of certificateFields(new NativeCertificate(pem).raw).validity.children){
    const {year}=timeValue(time);
    if(time.tag===24&&year>=1950&&year<2050)return false;
  }
  return true;
}
// certificate.py accesses every known leaf extension. Default CA policy parses
// only AIA/AKI/KU/BC/NC/EKU. Unknown extension payloads remain opaque.
const caDerOids=new Set(['1.3.6.1.5.5.7.1.1',...['35','15','19','30','37'].map(n=>'2.5.29.'+n)]);
const policyOids=new Set([...caDerOids,'2.5.29.14','2.5.29.17']);
const leafDerOids=new Set([...caDerOids,...['17','18','14','32','36','54','31','46','16'].map(n=>'2.5.29.'+n),
  '1.3.6.1.5.5.7.1.24','1.3.6.1.5.5.7.1.11','1.3.6.1.5.5.7.48.1.5','1.3.6.1.4.1.311.21.7','1.3.36.8.3.3',
  '1.3.6.1.4.1.11129.2.4.2','1.3.6.1.4.1.11129.2.4.3']);
const extensionSchemas:Record<string,{new():unknown}>={
  '2.5.29.17':pkix.SubjectAlternativeName,'2.5.29.18':pkix.IssueAlternativeName,
  '2.5.29.14':pkix.SubjectKeyIdentifier,'2.5.29.37':pkix.ExtendedKeyUsage,'2.5.29.15':pkix.KeyUsage,
  '1.3.6.1.5.5.7.1.1':pkix.AuthorityInfoAccessSyntax,'1.3.6.1.5.5.7.1.11':pkix.SubjectInfoAccessSyntax,
  '2.5.29.32':pkix.CertificatePolicies,'2.5.29.36':pkix.PolicyConstraints,'2.5.29.19':pkix.BasicConstraints,
  '2.5.29.35':pkix.AuthorityKeyIdentifier,'2.5.29.31':pkix.CRLDistributionPoints,'2.5.29.46':pkix.CRLDistributionPoints,
  '2.5.29.30':pkix.NameConstraints,'2.5.29.16':pkix.PrivateKeyUsagePeriod,
};
/** cryptography's SCT reader checks framing/algorithms, not CT log signatures. */
function checkSctList(data:Buffer):void {
  let p=0;
  function read(n:number):Buffer{if(p+n>data.length)throw new Error();const part=data.subarray(p,p+n);p+=n;return part;}
  function vector():Buffer{return read(read(2).readUInt16BE(0));}
  const list=vector();if(p!==data.length)throw new Error();p=0;data=list;
  while(p<data.length){
    const entry=vector(),rest=data,position=p;data=entry;p=0;
    if(read(1)[0]!==0)throw new Error();read(32);read(8);vector();
    if(![1,2,3,4,5,6].includes(read(1)[0])||![1,2,3].includes(read(1)[0]))throw new Error();
    vector();if(p!==data.length)throw new Error();data=rest;p=position;
  }
}
/** Admissions (RFC 3739) has optional fields; keep their ordering and complete consumption. */
function checkAdmissions(value:DerValue,objects:boolean):void {
  type Field=[number[],boolean,(v:DerValue)=>void];
  const nothing=()=>{};
  function ordered(node:DerValue,fields:Field[]):void{
    if(node.tag!==48)throw new Error();let i=0;
    for(const [tags,required,check] of fields){if(tags.includes(node.children[i]?.tag)){check(node.children[i++]);}else if(required)throw new Error();}
    if(i!==node.children.length)throw new Error();
  }
  function sequence(node:DerValue,check:(v:DerValue)=>void):void{if(node.tag!==48)throw new Error();node.children.forEach(check);}
  function text(v:DerValue):void{
    if(![12,22,26,30].includes(v.tag))throw new Error();
    if(v.tag===22&&v.content.some(b=>b>127))throw new Error();
    if([12,26].includes(v.tag))new TextDecoder('utf-8',{fatal:true}).decode(v.content);
  }
  function explicit(v:DerValue,check:(v:DerValue)=>void):void{if(v.children.length!==1)throw new Error();check(v.children[0]);}
  const nameTags=[160,129,130,164,134,135,136];
  const general=(v:DerValue)=>generalName(v,objects);
  const authority=(v:DerValue)=>ordered(v,[[[6],false,nothing],[[22],false,text],[[12,22,26,30],false,text]]);
  const profession=(v:DerValue)=>ordered(v,[[[160],false,n=>explicit(n,authority)],[[48],true,n=>sequence(n,text)],
    [[48],false,n=>sequence(n,o=>{if(o.tag!==6)throw new Error();})],[[19],false,nothing],[[4],false,nothing]]);
  const admission=(v:DerValue)=>ordered(v,[[[160],false,n=>explicit(n,general)],[[161],false,n=>explicit(n,authority)],[[48],true,n=>sequence(n,profession)]]);
  ordered(value,[[nameTags,false,general],[[48],true,n=>sequence(n,admission)]]);
}
function checkExtension(oid:string,value:DerValue,objects=false):void {
  const tag=oid==='2.5.29.15'?3:['2.5.29.14','1.3.6.1.4.1.11129.2.4.2'].includes(oid)?4:
    ['1.3.6.1.5.5.7.48.1.5','1.3.6.1.4.1.11129.2.4.3'].includes(oid)?5:oid==='2.5.29.54'?2:48;
  if(value.tag!==tag)throw new Error();
  const schema=extensionSchemas[oid];if(schema)AsnParser.parse(value.full,schema);
  if(['2.5.29.17','2.5.29.18'].includes(oid))value.children.forEach(v=>generalName(v,objects));
  if(['1.3.6.1.5.5.7.1.1','1.3.6.1.5.5.7.1.11'].includes(oid))value.children.forEach(v=>generalName(v.children[1],objects));
  if(oid==='2.5.29.35'){
    value.children.find(v=>v.tag===161)?.children.forEach(v=>generalName(v,objects));
    const serial=value.children.find(v=>v.tag===130);if(serial){const n=implicit(serial,2);if(n.content[0]&128)throw new Error();}
    if(objects&&(!!value.children.find(v=>v.tag===161)!==!!serial))throw new Error();
  }
  if(oid==='2.5.29.30')for(const group of value.children)for(const subtree of group.children){
    generalName(subtree.children[0],objects);
    for(const field of subtree.children.slice(1)){
      unsigned(implicit(field,2),64);
    }
  }
  if(oid==='2.5.29.36'){
    if(objects&&!value.children.length)throw new Error();
    for(const field of value.children)unsigned(implicit(field,2),64);
  }
  if(objects&&oid==='2.5.29.15'&&((value.content[1]&1)||(value.content[2]&128))&&!(value.content[1]&8))throw new Error();
  if(objects&&['2.5.29.31','2.5.29.46'].includes(oid))for(const point of value.children){
    const name=point.children.find(v=>v.tag===160)?.children[0],issuer=point.children.find(v=>v.tag===162);
    if(name?.tag===161&&!name.children.length)throw new Error();
    if(!name?.children.length&&!issuer?.children.length)throw new Error();
  }
  if(['2.5.29.31','2.5.29.46'].includes(oid))for(const point of value.children)for(const field of point.children){
    if(field.tag===129)implicit(field,3);
    if(field.tag===162)field.children.forEach(v=>generalName(v,objects));
    if(field.tag===160){const name=field.children[0];if(name.tag===160)name.children.forEach(v=>generalName(v,objects));else if(name.tag===161){const rdn=implicit(name,49);if(objects)objectRdn(rdn);}}
  }
  if(oid==='2.5.29.19')for(const child of value.children)if(child.tag===2)unsigned(child,64);
  if(oid==='2.5.29.32')policyQualifiers(value);
  if(oid==='1.3.6.1.5.5.7.1.24'&&(!value.children.length||value.children.some(v=>v.tag!==2||!['05','11'].includes(v.content.toString('hex')))))throw new Error();
  if(oid==='1.3.6.1.4.1.11129.2.4.2')checkSctList(value.content);
  if(oid==='1.3.36.8.3.3')checkAdmissions(value,objects);
  if(oid==='1.3.6.1.4.1.311.21.7'){
    if(!value.children.length||value.children.length>3||value.children[0].tag!==6)throw new Error();
    for(const v of value.children.slice(1)){
      if(v.tag!==2||(v.content[0]&128)||v.content.length>5)throw new Error();
      let version=0;for(const byte of v.content)version=version*256+byte;if(version>0xffffffff)throw new Error();
    }
  }
  if(oid==='2.5.29.54'&&(value.content[0]&128))throw new Error();
  if(oid==='2.5.29.16'){
    if(!value.children.length||value.children.length>2)throw new Error();
    const times=value.children.map((v,i)=>{
      if(![128,129].includes(v.tag)||(i&&value.children[i-1].tag>=v.tag))throw new Error();
      const time=timeValue({...v,tag:24});if(time.year<1)throw new Error();return time.date.getTime();
    });
    if(value.children.length===2&&times[0]>times[1])throw new Error();
  }
}
/** Read only TLV framing. Typed callers decide which payloads stay opaque. */
function framedDer(data:Buffer):DerValue[] {
  const result:DerValue[]=[];let p=0;
  while(p<data.length){
    const start=p,tag=data[p++];
    if((tag&31)===31){
      if(p>=data.length||data[p]===128)throw new Error();
      let number=0,byte:number;
      do{if(p>=data.length)throw new Error();byte=data[p++];number=number*128+(byte&127);if(number>0xffffffff)throw new Error();}while(byte&128);
      if(number<31)throw new Error();
    }
    if(p>=data.length)throw new Error();let length=data[p++];
    if(length&128){
      const n=length&127;if(!n||n>4||p+n>data.length||data[p]===0)throw new Error();
      length=0;for(let i=0;i<n;i++)length=length*256+data[p++];if(length<128)throw new Error();
    }
    const end=p+length;if(end>data.length)throw new Error();
    const content=data.subarray(p,end);let children:DerValue[]|undefined;
    result.push({tag,full:data.subarray(start,end),content,get children(){return children??=framedDer(content);}});p=end;
  }
  return result;
}
function framedOne(data:Buffer):DerValue {
  const values=framedDer(data);if(values.length!==1)throw new Error();return values[0];
}
/** RawTlv Name attributes are not Python NameAttribute objects at this phase. */
function oracleName(value:DerValue):void {
  if(value.tag!==48)throw new Error();
  for(const rdn of value.children){
    if(rdn.tag!==49)throw new Error();
    for(let i=1;i<rdn.children.length;i++)if(rdn.children[i-1].full.compare(rdn.children[i].full)>0)throw new Error();
    for(const attr of rdn.children){
      if(attr.tag!==48||attr.children.length!==2||attr.children[0].tag!==6)throw new Error();
      singleDer(attr.children[0].full);
      const raw=attr.children[1];if([19,28,30].includes(raw.tag))singleDer(raw.full);
    }
  }
}
function oracleGeneralName(value:DerValue):void {
  if([129,130,134].includes(value.tag)){new TextDecoder('utf-8',{fatal:true}).decode(value.content);return;}
  if(value.tag===135)return;
  if(value.tag===136){implicit(value,6);return;}
  if([163,165].includes(value.tag))return; // X400/EDI are opaque ASN.1 Sequence values.
  if(value.tag===164){if(value.children.length!==1)throw new Error();oracleName(value.children[0]);return;}
  if(value.tag!==160||value.children.length!==2||value.children[0].tag!==6||value.children[1].tag!==160||value.children[1].children.length!==1)throw new Error();
  singleDer(value.children[0].full); // OtherName.value's single RawTlv is otherwise opaque.
}
/** Typed CA/SAN syntax without recursive validation inside oracle-opaque values. */
function oracleExtension(oid:string,data:Buffer):DerValue {
  if(['2.5.29.15','2.5.29.19','2.5.29.37'].includes(oid)){
    const value=singleDer(data);checkExtension(oid,value);return value;
  }
  const value=framedOne(data);if(value.tag!==48)throw new Error();
  if(oid==='2.5.29.17'){value.children.forEach(oracleGeneralName);return value;}
  if(oid==='1.3.6.1.5.5.7.1.1'){
    for(const access of value.children){
      if(access.tag!==48||access.children.length!==2||access.children[0].tag!==6)throw new Error();
      singleDer(access.children[0].full);oracleGeneralName(access.children[1]);
    }
  }else if(oid==='2.5.29.35'){
    let i=0;const fields=value.children;
    if(fields[i]?.tag===128)i++;
    if(fields[i]?.tag===161)fields[i++].children.forEach(oracleGeneralName);
    // SerialNumber is a signed ASN.1 BigInt here, not certificate serial policy.
    if(fields[i]?.tag===130)implicit(fields[i++],2);
    if(i!==fields.length)throw new Error();
  }else if(oid==='2.5.29.30'){
    let previous=159;
    for(const group of value.children){
      if(![160,161].includes(group.tag)||group.tag<=previous)throw new Error();previous=group.tag;
      for(const subtree of group.children){
        if(subtree.tag!==48||!subtree.children.length)throw new Error();
        const fields=subtree.children;oracleGeneralName(fields[0]);let i=1;
        if(fields[i]?.tag===128&&unsigned(implicit(fields[i++],2),64)===0n)throw new Error();
        if(fields[i]?.tag===129)unsigned(implicit(fields[i++],2),64);
        if(i!==fields.length)throw new Error();
      }
    }
  }else throw new Error();
  return value;
}
function permittedEncoding(pem:string,leaf:boolean,oracle=false):boolean {
  try{
    // Preserve library-specific stronger refusals only after oracle traversal events.
    if(!leaf&&!oracle){
      new X509Certificate(pem);
      libraryExtensions(new NativeCertificate(pem).raw);
      if(!selfIssued(new NativeCertificate(pem))){
        const san=AsnParser.parse(new NativeCertificate(pem).raw,Certificate).tbsCertificate.extensions?.find(e=>e.extnID==='2.5.29.17');
        if(san)checkExtension('2.5.29.17',singleDer(Buffer.from(san.extnValue.buffer)));
      }
    }
    const native=new NativeCertificate(pem),cert=AsnParser.parse(native.raw,Certificate),raw=certificateFields(native.raw);
    const extensions=cert.tbsCertificate.extensions||[];
    const byId=new Map(extensions.map(e=>[e.extnID,e]));
    if(duplicateExtensions(native.raw)||extensions.some(e=>e.critical&&!policyOids.has(e.extnID)))return false;
    if(leaf){
      for(const id of ['1.3.6.1.5.5.7.1.1','2.5.29.35'])if(byId.get(id)?.critical)return false;
      const ku=byId.get('2.5.29.15');if(ku&&(singleDer(Buffer.from(ku.extnValue.buffer)).content[1]&4))return false;
      const eku=byId.get('2.5.29.37');
      if(eku&&!singleDer(Buffer.from(eku.extnValue.buffer)).children.some(v=>v.content.toString('hex')==='2b06010505070301'))return false;
    }
    if(!leaf){
      const ku=byId.get('2.5.29.15'),bc=byId.get('2.5.29.19');
      if(!ku||!bc?.critical||!(singleDer(Buffer.from(ku.extnValue.buffer)).content[1]&4))return false;
      for(const id of ['1.3.6.1.5.5.7.1.1','2.5.29.35','2.5.29.14','2.5.29.37'])if(byId.get(id)?.critical)return false;
      const aki=byId.get('2.5.29.35');
      if(aki&&!(oracle?oracleExtension('2.5.29.35',Buffer.from(aki.extnValue.buffer)):singleDer(Buffer.from(aki.extnValue.buffer))).children.some(v=>v.tag===128))return false;
      const eku=byId.get('2.5.29.37');
      if(eku&&!singleDer(Buffer.from(eku.extnValue.buffer)).children.some(v=>['551d2500','2b06010505070301'].includes(v.content.toString('hex'))))return false;
      const nc=byId.get('2.5.29.30');
      if(nc&&!(oracle?oracleExtension('2.5.29.30',Buffer.from(nc.extnValue.buffer)):singleDer(Buffer.from(nc.extnValue.buffer))).children.some(v=>v.children.length))return false;
    }
    if(leaf&&(cert.tbsCertificate.extensions||[]).some(e=>e.extnID==='2.5.29.30'||(e.extnID==='2.5.29.37'&&e.critical)))return false;
    for(const ext of cert.tbsCertificate.extensions||[]){
      if(!(leaf?leafDerOids:caDerOids).has(ext.extnID))continue;
      const value=oracle?oracleExtension(ext.extnID,Buffer.from(ext.extnValue.buffer)):singleDer(Buffer.from(ext.extnValue.buffer));
      if(!oracle)checkExtension(ext.extnID,value,leaf);
      if(ext.extnID==='2.5.29.19'&&value.children[0]?.tag===1&&value.children[0].content[0]===0)throw new Error(); // cA DEFAULT FALSE
      if(ext.extnID==='2.5.29.30')for(const group of value.children)for(const subtree of group.children){
        if(subtree.children.some(v=>v.tag===128&&v.content.equals(Buffer.from([0]))))throw new Error(); // minimum DEFAULT 0
      }
    }
    if(cert.tbsCertificate.subjectPublicKeyInfo.algorithm.algorithm==='1.2.840.113549.1.1.1'){
      const key=singleDer(raw.spki.children[1].content.subarray(1));
      if(key.tag!==48||key.children.length!==2||key.children.some(v=>v.tag!==2||(v.content[0]&128)))throw new Error();
    }
    if(raw.spki.children[1].content[0]!==0)throw new Error();
    return true;
  }catch{return false;}
}
// cryptography 50.0.2 policy/mod.rs: exact AlgorithmIdentifiers, including PSS
// hash/MGF/salt parameters. Issuer SPKI is independent of the leaf's public key.
const signatures=new Set([
  ...['0b','0c','0d'].map(id=>'300d06092a864886f70d0101'+id+'0500'),
  ...['02','03','04'].map(id=>'300a06082a8648ce3d0403'+id),
  ...['11','12','13'].map(id=>'300b06096086480165030403'+id), // ML-DSA 44/65/87
  ...[['01','20'],['02','30'],['03','40']].map(([hash,salt])=>{
    const digest='300d06096086480165030402'+hash+'0500';
    return '304106092a864886f70d01010a3034a00f'+digest+'a11c301a06092a864886f70d010108'+digest+'a2030201'+salt;
  }),
]);
function permittedSignature(pem:string):boolean{
  return signatures.has(singleDer(new NativeCertificate(pem).raw).children[1].full.toString('hex'));
}
const issuerAlgorithms=new Set([
  '300d06092a864886f70d0101010500', // rsaEncryption with NULL
  '301306072a8648ce3d020106082a8648ce3d030107', // P-256
  '301006072a8648ce3d020106052b81040022', // P-384
  '301006072a8648ce3d020106052b81040023', // P-521
  ...['11','12','13'].map(id=>'300b06096086480165030403'+id),
]);
function permittedIssuer(pem:string,oracle=false):boolean{
  const native=new NativeCertificate(pem);
  const cert=AsnParser.parse(native.raw,Certificate);
  if(!issuerAlgorithms.has(Buffer.from(AsnSerializer.serialize(cert.tbsCertificate.subjectPublicKeyInfo.algorithm)).toString('hex')))return false;
  if(oracle&&cert.tbsCertificate.subjectPublicKeyInfo.algorithm.algorithm==='1.2.840.113549.1.1.1'){
    const n=singleDer(certificateFields(native.raw).spki.children[1].content.subarray(1)).children[0];return n.content.length*8>=2048;
  }
  const bits=native.publicKey.asymmetricKeyDetails?.modulusLength;
  return bits===undefined||Math.ceil(bits/8)*8>=2048;
}
/** Signature linkage selects candidates only; OpenSSL still validates every accepted path. */
class CandidateParseFailure extends Error {}
function selfIssued(cert:NativeCertificate):boolean {
  const fields=certificateFields(cert.raw);return fields.issuer.full.equals(fields.subject.full);
}
/** A same-type constraint can match, miss, or fail parsing; other types are skipped. */
function constraintMatch(base:DerValue,san:DerValue,excluded:boolean):boolean|null|undefined {
  if(base.tag!==san.tag)return;
  const dns=(value:string):string|undefined=>{
    if(!value.length||value.length>253||value.split('.').some(label=>!label.length||label.length>63||!(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i).test(label)))return;
    return value.toLowerCase();
  };
  const within=(name:string,parent:string)=>name===parent||name.endsWith('.'+parent);
  if(base.tag===130){
    const pattern=san.content.toString('utf8'),wildcard=pattern.startsWith('*.');
    const name=dns(wildcard?pattern.slice(2):pattern),constraint=dns(base.content.toString('utf8'));
    if(name===undefined||constraint===undefined)return null;
    return within(name,constraint)||(excluded&&wildcard&&constraint.slice(constraint.indexOf('.')+1)===name&&constraint.includes('.'));
  }
  if(base.tag===129){
    const mailbox=(value:string):{local:string;domain:string}|undefined=>{
      const at=value.indexOf('@');if(at<1)return;
      const local=value.slice(0,at),domain=dns(value.slice(at+1));
      if(domain===undefined||local.split('.').some(part=>!(/^[a-z0-9!#$%&'*+\/=?^_`{|}~\-]+$/i).test(part)))return;
      return {local,domain};
    };
    const name=mailbox(san.content.toString('utf8')),text=base.content.toString('utf8');if(!name)return null;
    if(text.startsWith('.')){
      const domain=dns(text.slice(1));return domain===undefined?null:name.domain!==domain&&within(name.domain,domain);
    }
    const exact=mailbox(text);if(exact)return exact.local===name.local&&exact.domain===name.domain;
    const domain=dns(text);return domain===undefined?null:name.domain===domain;
  }
  if(base.tag===135){
    const bytes=base.content,name=san.content;if(![8,32].includes(bytes.length)||![4,16].includes(name.length))return null;
    const half=bytes.length/2;let zero=false;
    for(const byte of bytes.subarray(half))for(let bit=7;bit>=0;bit--){if(byte&(1<<bit)){if(zero)return null;}else zero=true;}
    if(name.length!==half)return false;
    return name.every((byte,i)=>(byte&bytes[i+half])===(bytes[i]&bytes[i+half]));
  }
  return null; // Matching unsupported types fail this candidate, rather than the entire search.
}
/** Apply oracle ordering/parse failures in addition to the native verifier's constraints. */
function nameConstraintsPermit(path:string[],charge:()=>void=()=>{}):boolean {
  const parent=AsnParser.parse(new NativeCertificate(path.at(-1)!).raw,Certificate);
  const nc=parent.tbsCertificate.extensions?.find(e=>e.extnID==='2.5.29.30');
  if(!nc)return true;
  const groups=oracleExtension('2.5.29.30',Buffer.from(nc.extnValue.buffer)).children;
  const bases=groups.flatMap(group=>group.children.map(subtree=>subtree.children[0]));
  if(nc.critical&&bases.some(base=>base.tag===164))throw new Error('unsupported critical name constraint');
  const permitted=groups.find(group=>group.tag===160)?.children||[],excluded=groups.find(group=>group.tag===161)?.children||[];
  for(const [i,pem] of path.entries()){
    const native=new NativeCertificate(pem);if(i>0&&selfIssued(native))continue;
    const san=AsnParser.parse(native.raw,Certificate).tbsCertificate.extensions?.find(e=>e.extnID==='2.5.29.17');
    if(!san)continue;
    for(const name of oracleExtension('2.5.29.17',Buffer.from(san.extnValue.buffer)).children){
      let permit=true;
      for(const subtree of permitted){
        charge();const result=constraintMatch(subtree.children[0],name,false);if(result===null)return false;
        if(result!==undefined){permit=result;if(permit)break;}
      }
      if(!permit)return false;
      for(const subtree of excluded){charge();const result=constraintMatch(subtree.children[0],name,true);if(result===null||result)return false;}
    }
  }
  return true;
}
/** Missing, malformed or duplicate extensions do not supply a candidate key ID. */
function keyIdentifier(cert:NativeCertificate,authority:boolean):Buffer|undefined {
  try{
    const extensions=AsnParser.parse(cert.raw,Certificate).tbsCertificate.extensions||[];
    if(duplicateExtensions(cert.raw))return;
    const ext=extensions.find(e=>e.extnID===(authority?'2.5.29.35':'2.5.29.14'));if(!ext)return;
    const value=authority?oracleExtension('2.5.29.35',Buffer.from(ext.extnValue.buffer)):singleDer(Buffer.from(ext.extnValue.buffer));
    if(authority)return value.children.find(v=>v.tag===128)?.content;
    if(value.tag===4)return value.content;
  }catch{/* Invalid IDs cannot improve a candidate's likelihood. */}
}
function* paths(chain:string[],trust:string[],now:Date,oracle=true):Generator<string[]> {
  const roots=trust.map(pem=>({pem,cert:new NativeCertificate(pem)}));
  const intermediates=chain.slice(1).map(pem=>({pem,cert:new NativeCertificate(pem)}));
  let visited=0,yielded=0,signatureChecks=1<<7,nameChecks=1<<20;
  const chargeName=()=>{if(oracle&&nameChecks--===0)throw new Error('name constraint budget exceeded');};
  function* visit(path:string[]):Generator<string[]> {
    if(++visited>128)throw new Error('certificate path budget exceeded');
    if(path.length>9||yielded>=32)return;
    const child=new NativeCertificate(path[path.length-1]);
    const want=keyIdentifier(child,true);
    const candidates=[...roots,...intermediates].map(parent=>{
      const have=keyIdentifier(parent.cert,false);
      return {parent,rank:want&&have?(want.equals(have)?0:2):1};
    }).sort((a,b)=>a.rank-b.rank); // Stable: trust-store order wins within a bucket.
    for(const {parent} of candidates){
      // Oracle retries repeated issuers under its depth/signature budgets.
      if(!oracle&&path.some(pem=>new NativeCertificate(pem).fingerprint256===parent.cert.fingerprint256))continue;
      if(!certificateFields(child.raw).issuer.full.equals(certificateFields(parent.cert.raw).subject.full))continue;
      // The oracle aborts this frame before candidate policy on duplicate OIDs.
      if(oracle&&duplicateExtensions(parent.cert.raw))throw new CandidateParseFailure();
      const next=[...path,parent.pem];
      try{
        if(!permittedEncoding(parent.pem,false,oracle)||!permittedBasic(parent.pem)||!permittedIssuer(parent.pem,oracle)||!permittedSignature(path.at(-1)!))continue;
        const ext=AsnParser.parse(parent.cert.raw,Certificate).tbsCertificate.extensions?.find(e=>e.extnID==='2.5.29.19');
        if(!ext)continue;const bc=singleDer(Buffer.from(ext.extnValue.buffer));
        if(bc.children[0]?.tag!==1||bc.children[0].content[0]!==255)continue;
        const length=bc.children.find(v=>v.tag===2);if(length&&BigInt(next.length-2)>unsigned(length,64))continue;
        const dates=certificateFields(parent.cert.raw).validity.children.map(v=>timeValue(v).date.getTime());
        if(now.getTime()<dates[0]||now.getTime()>dates[1])continue;
      }catch{continue;}
      let publicKey:KeyObject;
      try{publicKey=parent.cert.publicKey;}catch{continue;}
      if(oracle&&signatureChecks--===0)throw new Error('signature verification budget exceeded');
      try{if(!child.verify(publicKey))continue;}catch{continue;}
      if(oracle&&!selfIssued(parent.cert)){
        const parsed=AsnParser.parse(parent.cert.raw,Certificate);
        const san=parsed.tbsCertificate.extensions?.find(v=>v.extnID==='2.5.29.17');
        if(san)try{oracleExtension('2.5.29.17',Buffer.from(san.extnValue.buffer));}catch{throw new CandidateParseFailure();}
      }
      try{if(!nameConstraintsPermit(next,chargeName))continue;}catch(e){
        if(oracle)throw e;continue; // Preflight already accepted; an unvisited fatal cannot undo it.
      }
      if(roots.includes(parent)){yielded++;yield next;}
      else try{yield* visit(next);}catch(e){if(!(e instanceof CandidateParseFailure))throw e;}
    }
  }
  yield* visit([chain[0]]);
}
export async function validate(value: Bundle, fqdn: string, roots: string, now = new Date()): Promise<Metadata> {
  let directory: string | undefined;
  try {
    const blocks = certificates(value.certificatePem,true);
    if (!blocks?.length || !Number.isFinite(now.getTime())) throw new Error();
    const leaf = new NativeCertificate(blocks[0]);
    const privateKey=createPrivateKey(value.privateKeyPem);assertValidPrivateKey(privateKey);
    if (!leaf.checkPrivateKey(privateKey)) throw new Error();
    new X509Certificate(blocks[0]);
    const subject=AsnParser.parse(leaf.raw,Certificate).tbsCertificate.subject;
    const extensions=libraryExtensions(leaf.raw);
    const san = extensions.find((e):e is SubjectAlternativeNameExtension=>e instanceof SubjectAlternativeNameExtension);
    if (!san || (san.critical && subject.length!==0) || san.names.items.length !== 1 || san.names.items[0].type !== 'dns' || san.names.items[0].value !== fqdn) throw new Error();
    if (extensions.find((e):e is BasicConstraintsExtension=>e instanceof BasicConstraintsExtension)?.ca || duplicateExtensions(leaf.raw)) throw new Error();
    const anchors=certificates(roots);
    const gate=paths(blocks,anchors,now);
    const accepted=gate.next();gate.return(undefined);
    if(accepted.done)throw new Error();
    const first:string[]=accepted.value;
    function* candidates():Generator<string[]> {
      yield first; // Do not resume oracle traversal after its first successful path.
      yield* paths(blocks,anchors,now,false);
    }
    directory = await mkdtemp(join(tmpdir(), 'miwkey-cert-'));
    await writeFile(join(directory, 'leaf.pem'), blocks[0], {mode: 0o600});
    for (const candidate of candidates()) {
      // Basic policy includes the anchor; only its self-signature is exempt.
      if(!candidate.every((pem,i)=>permittedEncoding(pem,i===0))||!candidate.every(permittedBasic)||!candidate.slice(0,-1).every(permittedSignature)||!candidate.slice(1).every(pem=>permittedIssuer(pem)))continue;
      await writeFile(join(directory, 'roots.pem'), candidate[candidate.length - 1], {mode: 0o600});
      await writeFile(join(directory, 'chain.pem'), candidate.slice(1, -1).join('\n'), {mode: 0o600});
      try {
        await execute('/usr/bin/openssl', ['verify', '-trusted', join(directory, 'roots.pem'),
          '-x509_strict', '-purpose', 'sslserver', '-attime', String(Math.floor(now.getTime() / 1000)),
          ...candidate.length > 2 ? ['-untrusted', join(directory, 'chain.pem')] : [], join(directory, 'leaf.pem')],
          {timeout: 10000, maxBuffer: 32768, env: {PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null'}});
        return metadata({...value,certificatePem:blocks[0]});
      } catch { /* Try another explicitly trusted path; never log subprocess output. */ }
    }
    throw new Error();
  } catch { throw new Error('certificate validation failed'); }
  finally { if (directory) await rm(directory, {recursive: true, force: true}); }
}
export async function productionValidate(value: Bundle, fqdn: string, now = new Date()): Promise<Metadata> {
  return validate(value, fqdn, await readFile(join(__dirname, '../public-roots.pem'), 'utf8'), now);
}
export async function stagingValidate(value: Bundle, fqdn: string, now = new Date()): Promise<Metadata> {
  return validate(value, fqdn, await readFile(join(__dirname, '../staging-roots.pem'), 'utf8'), now);
}
