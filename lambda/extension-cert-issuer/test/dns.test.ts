import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Cloudflare, DnsLifecycle} from '../src/dns';
const name='_acme-challenge.notifications.example.com';
for (const status of [400, 401, 403, 404, 422, 200]) test(`explicit Cloudflare rejection never searches ownership: ${status}`, async () => {
 const original=globalThis.fetch;const methods:string[]=[];
 globalThis.fetch=async(_url,init)=>{methods.push(String(init?.method));return new Response(JSON.stringify({success:false,errors:[{message:'fixture-private-response'}]}),{status});};
 try {
  const api=new Cloudflare('zone','fixture-private-token',undefined,async()=>{});
  await assert.rejects(api.create(name,'fixture-private-txt'),{message:'Cloudflare request failed'});
  assert.deepEqual(methods,['POST']);
 } finally {globalThis.fetch=original;}
});
for (const status of [408, 429, 500, 503]) test(`unknown HTTP outcome searches ownership without repeating POST: ${status}`, async () => {
 const original=globalThis.fetch;const methods:string[]=[];let created:any;
 globalThis.fetch=async(_url,init)=>{
  methods.push(String(init?.method));
  if(init?.method==='POST'){created={...JSON.parse(String(init.body)),id:'mine'};return new Response('fixture-private-response',{status});}
  return new Response(JSON.stringify({success:true,result:[created]}),{status:200});
 };
 try {const result=await new Cloudflare('zone','fixture-token',undefined,async()=>{}).create(name,'fixture-value');assert.equal(result.id,'mine');assert.deepEqual(methods,['POST','GET']);}
 finally {globalThis.fetch=original;}
});
function records() {
 const map = new Map<string,any>([['other',{id:'other',name,type:'TXT',content:'existing',comment:'other'}]]);let posts=0;
 const transport=async(method:string,path:string,data?:any):Promise<any>=>{
  if(method==='POST'){posts++;const r={...data,id:'mine'};map.set('mine',r);return structuredClone(r);}
  if(path.includes('?'))return [...map.values()];const id=path.split('/').pop()!;
  if(method==='GET')return structuredClone(map.get(id));if(method==='DELETE'){map.delete(id);return {};}
 };
 return {map,transport,get posts(){return posts;}};
}
test('cleanup deletes only owned ID and preserves pre-existing TXT',async()=>{const r=records();const api=new Cloudflare('zone','fixture-token',r.transport,async()=>{});const d=new DnsLifecycle(api);await d.create(name,'fixture');await d.cleanup();assert.deepEqual([...r.map.keys()],['other']);assert.equal(r.posts,1);});
for(const field of ['name','type','content','comment'])test(`cleanup rejects changed ${field}`,async()=>{const r=records();const api=new Cloudflare('zone','token',r.transport,async()=>{});const d=new DnsLifecycle(api);await d.create(name,'fixture');r.map.get('mine')[field]='changed';await assert.rejects(d.cleanup());assert.ok(r.map.has('mine'));});
test('lost POST response recovers unique ownership without repeated POST',async()=>{const r=records();const api=new Cloudflare('zone','token',async(m,p,d)=>{const v=await r.transport(m,p,d);if(m==='POST')throw new Error('fixture-secret');return v;},async()=>{});const d=new DnsLifecycle(api);await d.create(name,'value');await d.cleanup();assert.equal(r.posts,1);assert.deepEqual([...r.map.keys()],['other']);});
test('ambiguous creation does not adopt unrelated record or repeat POST',async()=>{const r=records();let posts=0;const api=new Cloudflare('zone','token',async(m,p,d)=>{if(m==='POST'){posts++;throw new Error('secret');}return r.transport(m,p,d);},async()=>{});await assert.rejects(api.create(name,'value'),{message:'TXT creation outcome unknown'});assert.equal(posts,1);assert.ok(r.map.has('other'));});
test('multiple ownership matches are rejected',async()=>{const r=records();let created:any;const api=new Cloudflare('zone','token',async(m,p,d)=>{if(m==='POST'){created={...d,id:'a'};throw new Error();}if(p.includes('?'))return [created,{...created,id:'b'}];return r.transport(m,p,d);},async()=>{});await assert.rejects(api.create(name,'value'));});
test('cancellation joins delayed POST and tracks ownership before cleanup',async()=>{const r=records();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});const api=new Cloudflare('zone','token',async(m,p,d)=>{if(m==='POST'){started();await waiting;}return r.transport(m,p,d);},async()=>{});const life=new DnsLifecycle(api);const abort=new AbortController();const creation=life.create(name,'value',abort.signal);await start;abort.abort();const cleaning=life.cleanup();release();await assert.rejects(creation);await cleaning;assert.deepEqual([...r.map.keys()],['other']);});
test('bounded retries and errors do not expose token or content',async()=>{let calls=0;const api=new Cloudflare('zone','fixture-secret',async()=>{calls++;throw new Error('fixture-secret');},async()=>{});await assert.rejects(api.get('record'),{message:'Cloudflare request failed'});assert.equal(calls,3);});
test('initial propagation delay and both resolver evidence are required',async()=>{const r=records();const events:string[]=[];const life=new DnsLifecycle(new Cloudflare('zone','token',r.transport,async()=>{}),async()=>{events.push('sleep');},async()=>{events.push('lookup');return true;});await life.fulfill('notifications.example.com','value');assert.deepEqual(events,['sleep','lookup']);await life.cleanup();});
test('cleanup failure remains observable with ownership retained',async()=>{const r=records();const life=new DnsLifecycle(new Cloudflare('zone','token',async(m,p,d)=>{if(m==='DELETE')throw new Error('fixture-secret');return r.transport(m,p,d);},async()=>{}));await life.create(name,'fixture-secret-txt');await assert.rejects(life.cleanup(),{message:'DNS cleanup failed'});assert.ok(r.map.has('mine'));});

for(const field of ['name','type','content','comment','missing-tuple'])test(`POST id remains tracked after response ${field} mismatch`,async()=>{
 const r=records();const logs:string[]=[];const previous=console.log;console.log=(s:string)=>logs.push(s);
 try{
  const api=new Cloudflare('zone','private-token',async(m,p,d)=>{const result=await r.transport(m,p,d);if(m==='POST'){if(field==='missing-tuple')return {id:'mine'};return {...result,[field]:field==='content'?'"private-txt"':'changed'};}return result;},async()=>{});
  const life=new DnsLifecycle(api);await assert.rejects(life.create(name,'private-txt'));assert.ok(life.records.has('mine'));
  // GET returns the original, fully matching ownership tuple: safe to delete.
  await life.cleanup();assert.equal(r.map.has('mine'),false);assert.equal(r.posts,1);assert.ok(logs.some(s=>JSON.parse(s).recordId==='mine'));assert.ok(!logs.join('').includes('private-txt'));
 }finally{console.log=previous;}
});
test('quoted TXT left in place with non-secret evidence when GET does not match ownership',async()=>{
 const r=records();const logs:string[]=[];const previous=console.log;console.log=(s:string)=>logs.push(s);
 try{
  const api=new Cloudflare('zone','private-token',async(m,p,d)=>{const result=await r.transport(m,p,d);if(m==='POST'){r.map.get('mine').content='"private-txt"';return {...result,content:'"private-txt"'};}return result;},async()=>{});
  const life=new DnsLifecycle(api);await assert.rejects(life.create(name,'private-txt'));await assert.rejects(life.cleanup());assert.ok(life.records.has('mine'));assert.ok(r.map.has('mine'));assert.ok(logs.some(s=>JSON.parse(s).event==='dns-cleanup-failed'&&JSON.parse(s).recordId==='mine'));assert.ok(!logs.join('').includes('private-txt'));
 }finally{console.log=previous;}
});
test('cleanup never deletes when GET returns a different ID even with the expected tuple',async()=>{
 const r=records();const api=new Cloudflare('zone','token',async(m,p,d)=>{const result=await r.transport(m,p,d);return m==='GET'&&!p.includes('?')?{...result,id:'other'}:result;},async()=>{});
 const life=new DnsLifecycle(api);await life.create(name,'value');await assert.rejects(life.cleanup());assert.ok(r.map.has('mine'));
});
for(const id of ['', '   ', null, undefined])test(`missing POST ID is a failed creation with non-secret recovery evidence: ${String(id)}`,async()=>{
 const r=records();const logs:string[]=[];const previous=console.log;console.log=(s:string)=>logs.push(s);
 try{
  const api=new Cloudflare('zone','private-token',async(m,p,d)=>{const result=await r.transport(m,p,d);return m==='POST'?{...result,id}:result;},async()=>{});
  const life=new DnsLifecycle(api);await assert.rejects(life.create(name,'private-txt'));
  await life.cleanup();assert.equal(r.posts,1);assert.ok(r.map.has('mine'));assert.equal(life.records.size,0);
  const evidence=logs.map(s=>JSON.parse(s)).find(e=>e.event==='dns-creation-unidentified');
  assert.equal(evidence?.recordId,null);assert.equal(evidence?.name,name);assert.match(evidence?.comment,/^miwkey-issuer:/);
  assert.ok(!logs.join('').includes('private-txt'));assert.ok(!logs.join('').includes('private-token'));
 }finally{console.log=previous;}
});

const digest=Buffer.alloc(32,17).toString('base64url');
for(const lost of [false,true])test(`real Cloudflare adapter tracks a quoted DNS-01 tuple and cleans up exactly, lost response ${lost}`,async()=>{
 const original=globalThis.fetch;const methods:string[]=[];let stored:any;let lookups=0;
 globalThis.fetch=async(_url,init)=>{
  const method=String(init?.method);methods.push(method);
  if(method==='POST'){const payload=JSON.parse(String(init?.body));assert.equal(payload.content,digest);stored={...payload,id:'mine',content:'"'+digest+'"'};if(lost)throw new Error('fixture response lost');}
  if(method==='DELETE')stored=undefined;
  const result=method==='GET'&&String(_url).includes('?')?[stored]:stored;
  return new Response(JSON.stringify({success:true,result:result??{}}));
 };
 try{
  const life=new DnsLifecycle(new Cloudflare('zone','fixture-private-token',undefined,async()=>{}),async()=>{},async(_n,v)=>{lookups++;return v===digest;});
  await life.fulfill('notifications.example.com',digest);assert.equal(life.records.get('mine')?.content,'"'+digest+'"');
  await life.cleanup();assert.equal(stored,undefined);assert.equal(lookups,1);
  assert.deepEqual(methods,lost?['POST','GET','GET','DELETE']:['POST','GET','DELETE']);
 }finally{globalThis.fetch=original;}
});
test('cleanup refuses a spelling change after recording a verified quoted digest',async()=>{
 const r=records();const api=new Cloudflare('zone','token',async(m,p,d)=>{
  const result=await r.transport(m,p,d);if(m==='POST'){r.map.get('mine').content='"'+digest+'"';return {...result,content:'"'+digest+'"'};}return result;
 },async()=>{});
 const life=new DnsLifecycle(api);await life.create(name,digest);r.map.get('mine').content=digest;
 await assert.rejects(life.cleanup());assert.ok(r.map.has('mine'));
});
for(const content of ['"'+digest,'"'+digest+'" ""','"'+digest+' "','"'+digest+'\\"','"'+'A'.repeat(42)+'B"'])test('ambiguous TXT representation is not adopted: '+content.length,async()=>{
 const r=records();const api=new Cloudflare('zone','token',async(m,p,d)=>{const result=await r.transport(m,p,d);if(m==='POST'){r.map.get('mine').content=content;return {...result,content};}return result;},async()=>{});
 const life=new DnsLifecycle(api);await assert.rejects(life.create(name,digest));await assert.rejects(life.cleanup());assert.ok(r.map.has('mine'));
});
