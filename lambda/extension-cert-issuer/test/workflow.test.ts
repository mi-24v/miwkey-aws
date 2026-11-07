import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine, DeploymentRejected} from '../src/workflow';
const meta = {fingerprint: 'a'.repeat(64), notAfter: '2027-01-15T00:00:00Z'};
const bundle = {certificatePem: 'fixture-cert', privateKeyPem: 'fixture-key'};
const now = 1792195200;
class Memory {
  cert: any = {version: 'v1', value: bundle, meta}; state: any = {deployed: 'v1'};
  issued = 0; requests = 0; writes: string[] = []; telemetry: any; desired = 1;
  status = 'UPDATE_COMPLETE'; deployments: any[] = [{id: 'old', status: 'PRIMARY', rolloutState: 'COMPLETED'}];
  tasks: any[] = [{taskArn: 't1', startedBy: 'old'}]; logs: any[] = [{taskArn: 't1', versionId: 'v1', ...meta}];
  async token() {return 'fixture-token';} async account() {}
  async current() {return structuredClone(this.cert);} async loadState() {return structuredClone(this.state);}
  async saveState(state: any) {this.state = structuredClone(state);}
  async observe(): Promise<any> {return [this.status,this.deployments,this.tasks,this.logs,this.desired];}
  async issue() {this.issued++; return bundle;}
  async putCandidate() {this.writes.push('put'); return 'v2';}
  async readCandidate() {return bundle;}
  async promote() {this.writes.push('promote'); this.cert = {version: 'v2', value: bundle, meta};}
  async deploy() {this.requests++; return 'ecs-new';}
  async metrics(data: any) {this.telemetry = data;}
}
const engine = (io: Memory, valid = true, time = now) => new Engine(io, async () => {if (!valid) throw new Error('bad certificate'); return meta;}, time);
function unserved() {const io = new Memory(); io.cert.version = 'v2'; return io;}
function intent(io: Memory, id: string | null = null) {io.state.attemptedAt = now - 200; io.state.pending = {version: 'v2', deploymentId: id, meta, intentId: 'intent-one', beforeDeploymentIds: ['old']};}
function recovery(io: Memory) {return {expectedVersionId: io.cert.version, expectedStateToken: io.state.pending?.intentId || io.state.recoveryToken, expectedDeploymentId: io.deployments[0].id, quiescenceConfirmed: true};}
function served(io: Memory, id = 'replacement') {io.deployments = [{id,status: 'PRIMARY',rolloutState: 'COMPLETED',createdAt: now - 100}];io.tasks = [{taskArn:'t1',startedBy:id}];io.logs = [{taskArn:'t1',versionId:io.cert.version,...meta}];}

test('ordinary day neither issues nor deploys', async () => {const io = new Memory();await engine(io).run('scheduled');assert.equal(io.issued,0);assert.equal(io.requests,0);assert.equal(io.telemetry.ServingDays,90);});
for (const kind of ['unknown','capacity','mismatch','pending','replaced','in-progress']) test(`R1 renews without daily reissuance: ${kind}`, async () => {
 const io = new Memory();io.cert.meta = {...meta,notAfter:'2026-11-01T00:00:00Z'};
 if (kind==='unknown') io.logs=[];
 if (kind==='capacity') {io.logs=[];io.tasks=[];}
 if (kind==='mismatch') io.logs[0].versionId='older';
 if (['pending','replaced','in-progress'].includes(kind)) {intent(io,kind==='pending'?null:'gone');io.state.pending.version='v1';}
 if (kind==='in-progress') io.deployments[0].rolloutState='IN_PROGRESS';
 await engine(io).run('scheduled');assert.equal(io.issued,1);assert.deepEqual(io.writes,['put','promote']);assert.equal(io.state.deployed,'v1');
 await engine(io,true,now+86400).run('scheduled');assert.equal(io.issued,1);
 if (kind!=='mismatch') assert.equal(io.requests,0);
 if (io.state.pending && kind!=='mismatch') assert.equal(io.state.pending.version,'v1');
});
for (const status of ['UPDATE_IN_PROGRESS','UPDATE_ROLLBACK_IN_PROGRESS']) test(`stack defers deployment: ${status}`, async () => {const io=unserved();io.status=status;await engine(io).run('scheduled');assert.equal(io.requests,0);io.status='UPDATE_COMPLETE';await engine(io).run('scheduled');assert.equal(io.requests,1);assert.equal(io.telemetry.ApplyFailure,0);});
for (const kind of ['missing-log','wrong-version','wrong-fingerprint','wrong-expiry','wrong-startedBy','capacity','stack','multiple','active','rollout','missing-primary']) test(`only complete task proof succeeds: ${kind}`,async()=>{
 const io=unserved();intent(io,'replacement');served(io);
 if(kind==='missing-log')io.logs=[];if(kind==='wrong-version')io.logs[0].versionId='old';if(kind==='wrong-fingerprint')io.logs[0].fingerprint='b'.repeat(64);if(kind==='wrong-expiry')io.logs[0].notAfter='2026-10-30T00:00:00Z';if(kind==='wrong-startedBy')io.tasks[0].startedBy='old';if(kind==='capacity')io.desired=2;if(kind==='stack')io.status='UPDATE_IN_PROGRESS';if(kind==='multiple')io.deployments.push({id:'another'});if(kind==='active')io.deployments[0].status='ACTIVE';if(kind==='rollout')io.deployments[0].rolloutState='IN_PROGRESS';
 if(kind==='missing-primary')delete io.deployments[0].status;
 await engine(io).run('scheduled');assert.equal(io.state.deployed,'v1');assert.ok(io.state.pending);assert.equal(io.requests,0);
});
test('recovery without an explicit PRIMARY cannot consume the state token',async()=>{
 const io=unserved();intent(io);const event=recovery(io);delete io.deployments[0].status;
 await assert.rejects(engine(io).run('reconcile',false,false,event));
 assert.equal(io.requests,0);assert.equal(io.state.pending.intentId,'intent-one');
});
for(const id of [null,'gone','failed'])test(`actual current logs recover intent ${id}`,async()=>{const io=unserved();intent(io,id);served(io);await engine(io).run('scheduled');assert.equal(io.state.deployed,'v2');assert.equal(io.state.pending,undefined);assert.equal(io.requests,0);});
test('response loss adopts only unique new PRIMARY after attemptedAt',async()=>{const io=unserved();intent(io);io.deployments=[{id:'new',status:'PRIMARY',rolloutState:'IN_PROGRESS',createdAt:now-100}];await engine(io).run('scheduled');assert.equal(io.state.pending.deploymentId,'new');assert.equal(io.requests,0);});
for(const field of ['expectedVersionId','expectedStateToken','expectedDeploymentId','quiescenceConfirmed'])test(`guard rejects stale ${field}`,async()=>{const io=unserved();intent(io);const event={...recovery(io),[field]:'wrong'};await assert.rejects(engine(io).run('reconcile',false,false,event));assert.equal(io.requests,0);assert.equal(io.telemetry.ObserveFailure,0);assert.equal(io.telemetry.ApplyFailure,1);});
for(const pending of [true,false])test(`guarded recovery consumes token once pending=${pending}`,async()=>{const io=unserved();if(pending)intent(io);else{io.logs=[];await engine(io).run('scheduled');}const event=recovery(io);await engine(io).run('reconcile',false,false,event);assert.equal(io.requests,1);await assert.rejects(engine(io).run('reconcile',false,false,event));assert.equal(io.requests,1);});
test('rejected recovery consumes prior no-pending token',async()=>{const io=unserved();io.logs=[];await engine(io).run('scheduled');const event=recovery(io);io.deploy=async()=>{io.requests++;throw new DeploymentRejected();};await engine(io).run('reconcile',false,false,event);assert.equal(io.telemetry.ApplyFailure,1);await assert.rejects(engine(io).run('reconcile',false,false,event));assert.equal(io.requests,1);});
test('no pending recovery requires persisted unresolved state',async()=>{const io=unserved();await assert.rejects(engine(io).run('reconcile',false,false,{expectedVersionId:'v2',expectedStateToken:'None',expectedDeploymentId:'old',quiescenceConfirmed:true}));assert.equal(io.requests,0);});
test('no pending token changes after certificate change and is removed on proof',async()=>{const io=unserved();io.logs=[];await engine(io).run('scheduled');const old=recovery(io);io.cert.version='v3';await engine(io).run('scheduled');assert.notEqual(io.state.recoveryToken,old.expectedStateToken);await assert.rejects(engine(io).run('reconcile',false,false,old));served(io);await engine(io).run('scheduled');assert.equal(io.state.recoveryToken,undefined);assert.equal(io.state.deployed,'v3');});
test('failed intent persistence sends nothing',async()=>{const io=unserved();io.saveState=async()=>{throw new Error('store unavailable');};await assert.rejects(engine(io).run('scheduled'));assert.equal(io.requests,0);assert.equal(io.telemetry.StorageFailure,1);});
test('lost request response does not blindly resend',async()=>{const io=unserved();io.deploy=async()=>{io.requests++;throw new Error('fixture-secret-response');};await assert.rejects(engine(io).run('scheduled'));assert.equal(io.state.result,'ambiguous');await engine(io).run('scheduled');assert.equal(io.requests,1);});
test('final save failure recovers using persisted intent and actual proof',async()=>{const io=unserved();const save=io.saveState.bind(io);io.saveState=async s=>{if(s.result==='requested')throw new Error('store');await save(s);};await assert.rejects(engine(io).run('scheduled'));assert.equal(io.state.pending.deploymentId,null);io.saveState=save;served(io,'ecs-new');await engine(io).run('scheduled');assert.equal(io.requests,1);assert.equal(io.state.deployed,'v2');});
test('failed rollout alarm and elapsed delay retain their meaning',async()=>{const io=unserved();intent(io,'failed');io.deployments=[{id:'failed',rolloutState:'FAILED'}];await engine(io).run('scheduled');assert.equal(io.telemetry.ApplyFailure,1);await engine(io,true,now+2*86400).run('scheduled');assert.equal(io.telemetry.ApplyDelayDays,2);});
test('first startup proof needs no redeployment',async()=>{const io=unserved();io.state={};served(io);await engine(io).run('scheduled');assert.equal(io.state.deployed,'v2');assert.equal(io.requests,0);});
for(const mode of ['bootstrap','scheduled'])test(`invalid candidate never writes ${mode}`,async()=>{const io=new Memory();await assert.rejects(engine(io,false).run(mode,true));assert.deepEqual(io.writes,[]);assert.equal(io.requests,0);});
test('readback metadata tampering prevents promotion',async()=>{const io=new Memory();let calls=0;const e=new Engine(io,async()=>({...meta,fingerprint:++calls===1?meta.fingerprint:'b'.repeat(64)}),now);await assert.rejects(e.run('scheduled',true));assert.deepEqual(io.writes,['put']);});
test('bootstrap never deploys and staging never runs automatically',async()=>{const io=new Memory();await engine(io).run('bootstrap',true);assert.equal(io.requests,0);await assert.rejects(engine(io).run('scheduled',false,true));});
