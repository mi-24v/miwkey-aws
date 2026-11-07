/** Additive DNS-01 records, joined create operations and ownership-checked cleanup. */
import {safeErrorType} from './errors';
import {randomUUID} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
import {setTimeout as sleep} from 'node:timers/promises';
export interface DnsRecord {id:string;name:string;type:string;content:string;comment:string}
type Payload=Record<string,unknown>;
export type Transport=(method:string,path:string,data?:Payload)=>Promise<unknown>;
class CloudflareRejected extends Error {
 constructor(){super('Cloudflare request failed');}
}
const pause=(ms:number)=>sleep(ms);
const owned=(a:Partial<DnsRecord>,b:Partial<DnsRecord>)=>['name','type','content','comment'].every(k=>a[k as keyof DnsRecord]===b[k as keyof DnsRecord]);
// Cloudflare may return one quote pair around a DNS-01 digest. Accept only this
// unambiguous representation at creation, never normalize cleanup comparisons.
function createdTuple(a:Partial<DnsRecord>,b:Partial<DnsRecord>):boolean {
 if(owned(a,b))return true;
 const content=b.content;
 return b.type==='TXT'&&typeof content==='string'&&/^[A-Za-z0-9_-]{43}$/.test(content)&&
  Buffer.from(content,'base64url').toString('base64url')===content&&a.content==='"'+content+'"'&&
  ['name','type','comment'].every(k=>a[k as keyof DnsRecord]===b[k as keyof DnsRecord]);
}
function record(value:unknown):DnsRecord {
 if(!value||typeof value!=='object'||!['id','name','type','content','comment'].every(k=>typeof (value as Payload)[k]==='string'))throw new Error('invalid TXT record');
 if(!(value as DnsRecord).id.trim())throw new Error('invalid TXT record');
 return value as DnsRecord;
}
export class Cloudflare {
 readonly base:string;readonly transport:Transport;
 constructor(zone:string,readonly token:string,transport?:Transport,readonly wait=pause){this.base=`/zones/${zone}/dns_records`;this.transport=transport||this.http.bind(this);}
 async http(method:string,path:string,data?:Payload):Promise<unknown>{
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  if(response.status>=400&&response.status<500&&![408,429].includes(response.status))throw new CloudflareRejected();
  if(!response.ok)throw new Error('Cloudflare HTTP failure');
  const body=await response.json() as {success?:boolean;result?:unknown};
  if(body?.success===false)throw new CloudflareRejected();
  if(body?.success!==true)throw new Error('Cloudflare response unavailable');return body.result;
 }
 async request(method:string,path:string,data?:Payload):Promise<unknown>{
  for(let attempt=0;attempt<(method==='POST'?1:3);attempt++){
   try{return await this.transport(method,path,data);}catch(error){if(error instanceof CloudflareRejected)throw error;if(method!=='POST'&&attempt<2)await this.wait(1000*2**attempt);}
  }throw new Error('Cloudflare request failed');
 }
 async check(){await this.request('GET',this.base+'?type=TXT&per_page=1');}
 async create(name:string,value:string,track?:(expected:DnsRecord)=>void):Promise<DnsRecord>{
  const payload={name,type:'TXT',content:value,ttl:60,comment:'miwkey-issuer:'+randomUUID()};
  console.log(JSON.stringify({event:'dns-record-intent',name,comment:payload.comment}));
  let created:unknown;
  try{created=await this.request('POST',this.base,payload);}
  catch(error){
   if(error instanceof CloudflareRejected)throw error;
   const query=new URLSearchParams({'comment.exact':payload.comment,type:'TXT',per_page:'100'});
   for(let attempt=0;attempt<3;attempt++){
    const response=await this.request('GET',this.base+'?'+query);
    if(!Array.isArray(response))throw new Error('invalid TXT search');
    const matches=response.filter(r=>r&&typeof r==='object'&&createdTuple(r,payload));
    if(matches.length>1)throw new Error('ambiguous TXT ownership');
    if(matches.length===1){created=matches[0];break;}
    if(attempt<2)await this.wait(1000*2**attempt);
   }
   if(!created)throw new Error('TXT creation outcome unknown');
  }
  // A remote ID is evidence even if its returned tuple is malformed or normalized.
  // Retain the intended tuple, never adopt unverified remote ownership fields.
  if(created&&typeof created==='object'&&typeof (created as Payload).id==='string'&&((created as Payload).id as string).trim()){
   const expected={...payload,id:(created as Payload).id as string};track?.(expected);
   console.log(JSON.stringify({event:'dns-record-created',recordId:expected.id,name,comment:expected.comment}));
  }else{
   // The write may have succeeded, but no safe deletion handle is known.
   console.log(JSON.stringify({event:'dns-creation-unidentified',recordId:null,name,comment:payload.comment}));
   throw new Error('TXT creation record ID unavailable');
  }
  const result=record(created);
  if(!createdTuple(result,payload))throw new Error('created TXT ownership mismatch');
  // After proving ownership, remember the exact observed spelling for GET+DELETE.
  track?.({id:result.id,name:result.name,type:result.type,content:result.content,comment:result.comment});
  return structuredClone(result);
 }
 async get(id:string){return record(await this.request('GET',this.base+'/'+encodeURIComponent(id)));}
 async delete(id:string){await this.request('DELETE',this.base+'/'+encodeURIComponent(id));}
}
export async function publicTxt(name:string,value:string):Promise<boolean>{
 for(const server of ['1.1.1.1','8.8.8.8']){
  const resolver=new Resolver({timeout:5000,tries:1});resolver.setServers([server]);
  try{const answer=await resolver.resolveTxt(name+'.');if(!answer.some(fragments=>fragments.join('')===value))return false;}catch{return false;}
 }return true;
}
export class DnsLifecycle {
 readonly records=new Map<string,DnsRecord>();readonly creating=new Set<Promise<DnsRecord>>();
 constructor(readonly api:Cloudflare,readonly wait=pause,readonly lookup=publicTxt){}
 async create(name:string,value:string,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  // The request is bounded independently. Aborting the caller does not undo a remote POST.
  const creation=this.api.create(name,value,r=>{this.records.set(r.id,r);});
  this.creating.add(creation);
  try{await creation;signal?.throwIfAborted();}finally{this.creating.delete(creation);}
 }
 async fulfill(domain:string,value:string,signal?:AbortSignal):Promise<void>{
  const name='_acme-challenge.'+domain;await this.create(name,value,signal);await this.wait(5000);
  for(let i=0;i<12;i++){signal?.throwIfAborted();if(await this.lookup(name,value))return;await this.wait(5000);}
  throw new Error('DNS propagation timed out');
 }
 async cleanup():Promise<void>{
  await Promise.allSettled([...this.creating]);const errors:string[]=[];
  for(const [id,record] of this.records){
   try{const current=await this.api.get(id);if(current.id!==id||!owned(current,record))throw new Error('TXT ownership mismatch');await this.api.delete(id);this.records.delete(id);}
   catch(error){console.log(JSON.stringify({event:'dns-cleanup-failed',recordId:id,name:record.name,comment:record.comment,errorType:safeErrorType(error)}));errors.push(id);}
  }
  if(errors.length)throw new Error('DNS cleanup failed');
 }
}
