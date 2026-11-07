import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ECSClient} from '@aws-sdk/client-ecs';
import {AwsIO, updateClientOptions} from '../src/aws';
import {DeploymentRejected} from '../src/workflow';
function sdk(send:(c:any)=>Promise<any>):any{return {send};}
for(const [status,code] of [[500,'ServerException'],[400,'ThrottlingException']] as const)test(`actual ECS transport sends exactly once: ${code}`,async()=>{
 let sends=0;const server=createServer((req,res)=>{sends++;res.writeHead(status,{'Content-Type':'application/x-amz-json-1.1'});res.end(JSON.stringify({__type:code,message:'fixture-private-response'}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 const client=new ECSClient({...updateClientOptions(),region:'us-east-1',credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'},endpoint:`http://127.0.0.1:${port}`});
 try{const io=new AwsIO({CLUSTER:'cluster',SERVICE:'extension'},{update:client});if(status===400)await assert.rejects(io.deploy(),DeploymentRejected);else await assert.rejects(io.deploy());assert.equal(sends,1);}finally{client.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('deployment changes only forceNewDeployment on intended service',async()=>{let input:any;const io=new AwsIO({CLUSTER:'cluster',SERVICE:'extension'},{update:sdk(async c=>{input=c.input;return {service:{deployments:[{id:'new',status:'PRIMARY'}]}};})});assert.equal(await io.deploy(),'new');assert.deepEqual(input,{cluster:'cluster',service:'extension',forceNewDeployment:true});});
test('certificate write/readback/promotion explicitly remove pending stage',async()=>{const calls:any[]=[];const io=new AwsIO({CERT_SECRET:'cert'},{secrets:sdk(async c=>{calls.push([c.constructor.name,c.input]);return {VersionId:'new',SecretString:'{"certificatePem":"fixture","privateKeyPem":"fixture"}'};})});const value={certificatePem:'fixture',privateKeyPem:'fixture'};const current={version:'old',value,meta:{fingerprint:'a'.repeat(64),notAfter:'2027-01-15T00:00:00Z'}};await io.current(false).catch(()=>{});calls.length=0;assert.equal(await io.putCandidate(value,current,false),'new');await io.readCandidate('new',false);await io.promote('new','old');assert.deepEqual(calls.map(c=>c[0]),['PutSecretValueCommand','GetSecretValueCommand','UpdateSecretVersionStageCommand','UpdateSecretVersionStageCommand']);assert.deepEqual(calls[0][1].VersionStages,['AWSPENDING']);assert.deepEqual(calls[3][1],{SecretId:'cert',VersionStage:'AWSPENDING',RemoveFromVersionId:'new'});});
test('staging writes never select production secret and first write is current',async()=>{let input:any;const io=new AwsIO({CERT_SECRET:'prod',STAGING_CERT_SECRET:'stage'},{secrets:sdk(async c=>{input=c.input;return {VersionId:'new'};})});await io.putCandidate({certificatePem:'fixture',privateKeyPem:'fixture'},null,true);assert.equal(input.SecretId,'stage');assert.equal(input.VersionStages,undefined);});
test('account missing in scheduled mode never creates account',async()=>{const io=new AwsIO({ACCOUNT_SECRET:'account'},{secrets:sdk(async()=>{throw Object.assign(new Error('private'),{name:'ResourceNotFoundException'});})});await assert.rejects(io.account(false,false),{message:'ACME account needs explicit bootstrap'});});
test('state serialization preserves epoch seconds and recovery token',async()=>{let value:any;const io=new AwsIO({STATE_PARAMETER:'state'},{ssm:sdk(async c=>{if(c.constructor.name==='PutParameterCommand'){value=c.input;return {};}return {Parameter:{Value:value.Value}};})});const state={current:'v2',deployed:'v1',unresolvedSince:1792195200,recoveryToken:'fixture-token',pending:{version:'v1',deploymentId:null,meta:{fingerprint:'a'.repeat(64),notAfter:'2027-01-15T00:00:00Z'},intentId:'old-intent'}};await io.saveState(state);assert.deepEqual(await io.loadState(),state);assert.equal(value.Type,'String');assert.equal(value.Overwrite,true);});
test('inventory paginates running tasks and excludes unrelated malformed startup logs',async()=>{
 const io=new AwsIO({STACK:'stack',CLUSTER:'cluster',SERVICE:'extension'},{cfn:sdk(async()=>({Stacks:[{StackStatus:'UPDATE_COMPLETE'}]})),ecs:sdk(async c=>{
 if(c.constructor.name==='DescribeServicesCommand')return {services:[{desiredCount:2,deployments:[{id:'new',status:'PRIMARY',rolloutState:'COMPLETED'}]}]};
 if(c.constructor.name==='ListTasksCommand')return c.input.nextToken?{taskArns:['cluster/t2']}:{taskArns:['cluster/t1'],nextToken:'next'};
 return {tasks:c.input.tasks.map((taskArn:string)=>({taskArn,startedBy:'new',lastStatus:'RUNNING'}))};}),logs:sdk(async c=>({events:[{message:'private malformed'},{message:JSON.stringify({msg:'tls certificate loaded',taskArn:c.input.logStreamNames[0].endsWith('t1')?'cluster/t1':'unknown',secretVersionId:'v2',certFingerprintSha256:'a'.repeat(64),certNotAfter:'2027-01-15T00:00:00Z'})}]}))});
 const [status,deployments,tasks,logs,desired]=await io.observe();assert.equal(status,'UPDATE_COMPLETE');assert.equal(desired,2);assert.equal(tasks.length,2);assert.equal(logs.length,1);assert.equal(logs[0].taskArn,'cluster/t1');assert.equal(deployments[0].id,'new');
});

test('state evidence preserves missing deployment fields as explicit null without secret state',async()=>{
 const logs:string[]=[];const original=console.log;console.log=(s:string)=>logs.push(s);
 try{const io=new AwsIO({STATE_PARAMETER:'state'},{ssm:sdk(async()=>({}))});await io.saveState({result:'completed',recoveryToken:'private-recovery-token'});
 assert.deepEqual(JSON.parse(logs[0]),{event:'deployment-state',result:'completed',currentVersionId:null,deployedVersionId:null,requestedVersionId:null,deploymentId:null});assert.ok(!logs.join('').includes('private-recovery-token'));
 }finally{console.log=original;}
});
