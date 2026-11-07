import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPrivateKey, generateKeyPairSync} from 'node:crypto';
import {restore, bootstrapAccount, issue, directories} from '../src/acme';
import {Cloudflare} from '../src/dns';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'});
const state=(staging=false)=>JSON.stringify({directory:directories[Number(staging)],key,account_url:directories[Number(staging)].replace('/directory','/acme/acct/123')});
const api=new Cloudflare('zone','fixture-token');
for(const staging of [true,false])test(`account restoration preserves RSA JWK and environment ${staging}`,()=>{
 let seen:any;restore(state(staging),staging,undefined,options=>{seen=options;return {} as any;});
 assert.equal(seen.directoryUrl,directories[Number(staging)]);assert.equal(createPrivateKey(seen.accountKey).export({format:'jwk'}).n,key.n);assert.equal(seen.accountUrl,JSON.parse(state(staging)).account_url);
});
for(const kind of ['directory','host','query','fragment','scheme','path'])test(`account restore rejects ${kind} mismatch before client creation`,()=>{const value=JSON.parse(state());if(kind==='directory')value.directory=directories[1];if(kind==='host')value.account_url='https://example.com/acme/acct/123';if(kind==='query')value.account_url+='?extra=1';if(kind==='fragment')value.account_url+='#fragment';if(kind==='scheme')value.account_url=value.account_url.replace('https:','http:');if(kind==='path')value.account_url=value.account_url.replace('/acme/acct/','/directory/');let calls=0;assert.throws(()=>restore(JSON.stringify(value),false,undefined,()=>{calls++;return {} as any;}));assert.equal(calls,0);});
test('bootstrap explicitly creates account and persists interoperable JWK',async()=>{let payload:any;const stored=JSON.parse(await bootstrapAccount(false,'admin@example.com',()=>({createAccount:async(p:any)=>{payload=p;},getAccountUrl:()=>directories[0].replace('/directory','/acme/acct/1')} as any)));assert.equal(stored.directory,directories[0]);assert.equal(stored.key.kty,'RSA');assert.equal(payload.termsOfServiceAgreed,true);assert.deepEqual(payload.contact,['mailto:admin@example.com']);});
function client(events:string[],challenge='dns-01') {let complete=false;return {createOrder:async()=>{events.push('order');return {};},getAuthorizations:async()=>[{identifier:{type:'dns',value:'notifications.example.com'},status:complete?'valid':'pending',challenges:[{type:challenge,url:'https://example.com/challenge',token:'fixture'}]}],getChallengeKeyAuthorization:async()=> 'already-hashed-dns-value',completeChallenge:async()=>{complete=true;events.push('complete');return {};},getOrder:async()=>{events.push('wait');return {status:'valid'};},finalizeOrder:async()=>{events.push('finalize');return {};},getCertificate:async()=>{events.push('certificate');return 'fixture-public-certificate';}};}
test('low-level issuance uses DNS digest once and cleanup completes before returning',async()=>{const events:string[]=[];let value='';const result=await issue(state(),false,api,'notifications.example.com',{clientFactory:()=>client(events) as any,lifecycleFactory:()=>({fulfill:async(d:string,v:string)=>{assert.equal(d,'notifications.example.com');value=v;events.push('dns');},cleanup:async()=>{events.push('cleanup');}})});assert.equal(value,'already-hashed-dns-value');assert.deepEqual(events,['order','dns','complete','finalize','wait','certificate','cleanup']);assert.equal(result.certificatePem,'fixture-public-certificate');assert.equal(createPrivateKey(result.privateKeyPem).asymmetricKeyType,'ec');});
test('unsupported challenge still cleans up and never notifies CA',async()=>{const events:string[]=[];await assert.rejects(issue(state(),false,api,'notifications.example.com',{clientFactory:()=>client(events,'http-01') as any,lifecycleFactory:()=>({fulfill:async()=>{throw new Error('unexpected');},cleanup:async()=>{events.push('cleanup');}})}));assert.deepEqual(events,['order','cleanup']);});
test('cleanup failure is not suppressed after successful issuance',async()=>{await assert.rejects(issue(state(),false,api,'notifications.example.com',{clientFactory:()=>client([]) as any,lifecycleFactory:()=>({fulfill:async()=>{},cleanup:async()=>{throw new Error('DNS cleanup failed');}})}),{message:'DNS cleanup failed'});});
test('aborted issuance joins lifecycle cleanup and sends no next ACME action',async()=>{const events:string[]=[];await assert.rejects(issue(state(),false,api,'notifications.example.com',{timeoutMs:100,clientFactory:()=>client(events) as any,lifecycleFactory:()=>({fulfill:async(_d,_v,signal)=>{assert.ok(signal);await new Promise<void>(resolve=>{if(signal!.aborted)resolve();else signal!.addEventListener('abort',()=>resolve(),{once:true});});},cleanup:async()=>{events.push('cleanup');}})}));assert.deepEqual(events,['order','cleanup']);});

// Generated offline by gufo_acme 0.7.0 AcmeClient.get_state(), with a disposable key.
const gufo=JSON.parse(readFileSync('test/fixtures/gufo-state.json','utf8'));
for(const staging of [false,true])test(`gufo account restores without registering ${staging}`,()=>{
 const value={...gufo,directory:directories[Number(staging)],account_url:directories[Number(staging)].replace('/directory','/acme/acct/123456')};
 let seen:any;const restored=restore(JSON.stringify(value),staging,undefined,options=>{seen=options;return {} as any;});
 assert.ok(restored);assert.equal(createPrivateKey(seen.accountKey).export({format:'jwk'}).n,gufo.key.n);assert.equal(seen.accountUrl,value.account_url);
});
for(const field of ['n','e','d','p','q','dp','dq','qi','kty-null','kty-EC'])test(`gufo compatibility rejects incomplete or non-RSA key ${field}`,()=>{
 const value=structuredClone(gufo);if(field.startsWith('kty-'))value.key.kty=field==='kty-null'?null:'EC';else delete value.key[field];
 let clients=0;assert.throws(()=>restore(JSON.stringify(value),false,undefined,()=>{clients++;return {} as any;}));assert.equal(clients,0);
});
for(const field of ['n','e','d','p','q','dp','dq','qi'])test(`gufo restore rejects internally inconsistent RSA ${field} before creating client`,()=>{
 const value=structuredClone(gufo);value.key[field]=field==='e'?'Aw':key[field];
 let clients=0;assert.throws(()=>restore(JSON.stringify(value),false,undefined,()=>{clients++;return {} as any;}),{message:'ACME account environment mismatch'});
 assert.equal(clients,0);
});

// Exercise the real Client/JWS/polling boundary; only the remote CA is replaced.
for(const stage of ['challenge','order','abort','http-error','invalid'])test(`real CA ${stage} processing may exceed seventeen seconds`,async()=>{
 const acme=await import('acme-client');const saved=acme.axios.defaults.adapter;const counts:Record<string,number>={};let nonce=0,cleaned=false;const started=Date.now();
 acme.axios.defaults.adapter=async config=>{
  const {origin,pathname:p}=new URL(config.url!);counts[p]=(counts[p]||0)+1;
  const headers:Record<string,string>={'replay-nonce':String(++nonce)};let data:any,status=200;
  if(p==='/directory'){if(stage==='http-error')status=500;data={newNonce:origin+'/nonce',newAccount:origin+'/new-account',newOrder:origin+'/new-order'};}
  else if(p==='/nonce')data='';
  else if(p==='/new-order'){status=201;headers.location=origin+'/order/1';data={status:'pending',authorizations:[origin+'/authz/1'],finalize:origin+'/finalize/1'};}
  else if(p==='/authz/1')data={status:counts[p]===1||(['challenge','abort','invalid'].includes(stage)&&Date.now()-started<18000)?(stage==='invalid'&&counts[p]>1?'invalid':'pending'):'valid',identifier:{type:'dns',value:'notifications.example.com'},challenges:[{type:'dns-01',url:origin+'/challenge/1',token:'fixture'}]};
  else if(p==='/challenge/1')data={status:stage==='challenge'?'processing':'valid'};
  else if(p==='/finalize/1')data={status:'processing'};
  else if(p==='/order/1')data={status:stage==='order'&&Date.now()-started<18000?'processing':'valid',certificate:origin+'/cert/1'};
  else if(p==='/cert/1')data='public-certificate';
  else throw new Error('unexpected CA action');
  return {data,status,statusText:'fixture',headers,config};
 };
 try{if(['abort','http-error','invalid'].includes(stage)){await assert.rejects(issue(state(),false,api,'notifications.example.com',{timeoutMs:stage==='abort'?100:600000,lifecycleFactory:()=>({fulfill:async()=>{},cleanup:async()=>{cleaned=true;}})}));assert.ok(cleaned);assert.ok(Date.now()-started<1000);assert.equal(counts[stage==='http-error'?'/directory':'/challenge/1'],1);return;}const issued=await issue(state(),false,api,'notifications.example.com',{lifecycleFactory:()=>({fulfill:async()=>{},cleanup:async()=>{cleaned=true;}})});
  assert.equal(issued.certificatePem,'public-certificate');assert.ok(Date.now()-started>=18000);assert.ok(cleaned);assert.equal(counts['/new-account'],undefined);assert.equal(counts['/new-order'],1);assert.equal(counts['/challenge/1'],1);assert.equal(counts['/finalize/1'],1);
 }finally{acme.axios.defaults.adapter=saved;}
});
