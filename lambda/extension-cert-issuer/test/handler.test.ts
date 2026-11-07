import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invoke} from '../src/handler';
const environment={FQDN:'notifications.example.com',RENEWAL_DAYS:'30'};
for(const event of [null,[],{}, {mode:'unknown'}, {mode:'scheduled',force:'true'}, {mode:'scheduled',force:null}, {mode:'bootstrap',staging:null}, {mode:'bootstrap',staging:1},{mode:'scheduled',extra:'fixture-secret'},{mode:'scheduled',staging:true},{mode:'reconcile'}])test(`invalid invocation is rejected before IO: ${JSON.stringify(event)}`,async()=>{let calls=0;await assert.rejects(invoke(event,environment,()=>{calls++;throw new Error('fixture-secret');}),{message:'certificate issuer failed; inspect non-secret state and metrics'});assert.equal(calls,0);});
test('secret-bearing failure is absent from response, logs and chained cause',async()=>{const logs:string[]=[];const original=console.log;console.log=(s:string)=>logs.push(s);try{const io:any={token:async()=>{throw new Error('PRIVATE-KEY JWT TOKEN PAYLOAD');},metrics:async()=>{}};await assert.rejects(invoke({mode:'scheduled'},environment,()=>io),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal(error.cause,undefined);assert.ok(!/PRIVATE-KEY|JWT|TOKEN|PAYLOAD/.test(error.message+error.stack+logs.join('')));return true;});}finally{console.log=original;}});
test('bootstrap with an existing unexpired certificate performs no deployment',async()=>{let deploys=0;const io:any={token:async()=> 'token',account:async()=>{},current:async()=>({version:'v1',value:{},meta:{fingerprint:'a'.repeat(64),notAfter:'2099-01-01T00:00:00Z'}}),deploy:async()=>{deploys++;},metrics:async()=>{}};assert.deepEqual(await invoke({mode:'bootstrap'},environment,()=>io),{result:'complete'});assert.equal(deploys,0);});

for(const variant of ['TypeError','SyntaxError','spoofed-name','secret-constructor'])test(`failure logs preserve safe type and suppress secret details: ${variant}`,async()=>{
 const logs:string[]=[];const original=console.log;console.log=(s:string)=>logs.push(s);
 try{let error:Error=variant==='TypeError'?new TypeError('PRIVATE-KEY TOKEN'):variant==='SyntaxError'?new SyntaxError('PRIVATE-KEY TOKEN'):new Error('PRIVATE-KEY TOKEN');
 if(variant==='spoofed-name')error.name='PRIVATE-KEY TOKEN';if(variant==='secret-constructor')Object.defineProperty(error,'constructor',{value:{name:'PRIVATE-KEY TOKEN'}});
 const io:any={token:async()=>{throw error;},metrics:async()=>{}};await assert.rejects(invoke({mode:'scheduled'},environment,()=>io));
 const failure=logs.map(s=>JSON.parse(s)).find(e=>e.event==='issuer-failure');assert.equal(failure.errorType,variant==='TypeError'?'TypeError':variant==='SyntaxError'?'SyntaxError':'Error');assert.ok(!logs.join('').includes('PRIVATE-KEY TOKEN'));
 }finally{console.log=original;}
});
