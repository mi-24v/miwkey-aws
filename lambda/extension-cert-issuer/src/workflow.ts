/** Persisted fields intentionally retain the Python issuer's JSON schema and epoch seconds. */
import {safeErrorType} from './errors';
import {randomUUID} from 'node:crypto';
import {Bundle, Metadata} from './certificate';
export class DeploymentRejected extends Error {}
export interface Current {version: string; value: Bundle; meta: Metadata}
export interface Deployment {id: string; status?: string; rolloutState?: string; createdAt?: Date | string | number}
export interface Task {taskArn: string; startedBy?: string}
export interface Startup extends Metadata {taskArn: string; versionId: string}
export interface Pending {version: string; deploymentId: string | null; meta: Metadata; intentId?: string; beforeDeploymentIds?: string[]}
export interface State {current?: string; deployed?: string; pending?: Pending; attemptedAt?: number; attempts?: number; unresolvedSince?: number; recoveryToken?: string; result?: string}
export interface IO {
 token(): Promise<string>; account(bootstrap: boolean, staging: boolean): Promise<void>; current(staging: boolean): Promise<Current | null>;
 loadState(): Promise<State>; saveState(state: State): Promise<void>;
 observe(): Promise<[string, Deployment[], Task[], Startup[], number]>;
 issue(token: string, bootstrap: boolean, staging: boolean): Promise<Bundle>;
 putCandidate(value: Bundle, current: Current | null, staging: boolean): Promise<string>; readCandidate(version: string, staging: boolean): Promise<Bundle>;
 promote(version: string, old: string): Promise<void>; deploy(): Promise<string>; metrics(data: Record<string, number>): Promise<void>;
}
const stable = ['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'];
const seconds = (v: Date | string | number) => typeof v === 'number' ? v : new Date(v).getTime()/1000;
type Observation = [string, Deployment[], Task[], Map<string, Startup>, number];
export class Engine {
 phase = 'invocation'; metrics: Record<string, number> = Object.fromEntries(['UnknownTasks','MismatchTasks','ApplyFailure','ApplyDelayDays','IssueFailure','DeployRequestFailure','TokenFailure','AccountFailure','ObserveFailure','ValidationFailure','StorageFailure'].map(n=>[n,0]));
 constructor(readonly io: IO, readonly validate: (value: Bundle, staging: boolean) => Promise<Metadata>, readonly now = Date.now()/1000, readonly renewalDays = 30) {}
 days(meta: Metadata) {return (seconds(meta.notAfter)-this.now)/86400;}
 matches(log: Partial<Startup> | undefined, current: Current) {return log?.versionId === current.version && log.fingerprint === current.meta.fingerprint && log.notAfter === current.meta.notAfter;}
 async observe(current: Current | null): Promise<Observation> {
  this.phase='observe'; const [status,deployments,tasks,records,desired]=await this.io.observe();
  const logs=new Map(records.map(l=>[l.taskArn,l])); const known=tasks.flatMap(t=>logs.has(t.taskArn)?[logs.get(t.taskArn)!]:[]);
  this.metrics.UnknownTasks=tasks.length-known.length+Math.max(0,desired-tasks.length);
  if(known.length)this.metrics.ServingDays=Math.min(...known.map(l=>this.days(l)));
  if(current)this.metrics.MismatchTasks=known.filter(l=>!this.matches(l,current)).length;
  return [status,deployments,tasks,logs,desired];
 }
 async publish(current: Current | null,value: Bundle,staging: boolean): Promise<Current> {
  this.phase='validate';const meta=await this.validate(value,staging);this.phase='store';const version=await this.io.putCandidate(value,current,staging);
  if(current){const reread=await this.io.readCandidate(version,staging);this.phase='validate';const checked=await this.validate(reread,staging);if(checked.fingerprint!==meta.fingerprint||checked.notAfter!==meta.notAfter)throw new Error('candidate changed');this.phase='promote';await this.io.promote(version,current.version);}
  console.log(JSON.stringify({event:'certificate-stored',versionId:version,...meta}));return {version,value,meta};
 }
 async save(state: State) {this.phase='save-state';await this.io.saveState(state);}
 async unresolved(state: State,result: string,failed=false) {
  state.result=result;state.unresolvedSince??=this.now;state.recoveryToken??=randomUUID();this.metrics.ApplyDelayDays=Math.max(0,(this.now-state.unresolvedSince)/86400);this.metrics.ApplyFailure=Number(failed);await this.save(state);
 }
 stateToken(state: State) {return state.pending?.intentId||state.recoveryToken;}
 async request(current: Current,state: State,deployments: Deployment[]) {
  this.phase='validate';await this.validate(current.value,false);
  state.pending={version:current.version,deploymentId:null,meta:current.meta,intentId:randomUUID(),beforeDeploymentIds:deployments.map(d=>d.id)};
  delete state.recoveryToken;state.attempts=(state.attempts||0)+1;state.attemptedAt=this.now;state.unresolvedSince??=this.now;state.result='requesting';
  await this.save(state);this.phase='deploy';
  let id: string;
  try {id=await this.io.deploy();}
  catch(error){if(error instanceof DeploymentRejected){delete state.pending;await this.unresolved(state,'rejected',true);return;}await this.unresolved(state,'ambiguous');this.phase='deploy';throw error;}
  state.pending.deploymentId=id;state.result='requested';await this.save(state);
 }
 async apply(current: Current,state: State,[status,deployments,tasks,logs,desired]: Observation,recovery?: unknown) {
  this.phase='apply';if(state.current!==current.version)delete state.recoveryToken;state.current=current.version;
  const pending=state.pending;
  if(recovery!==undefined){
   this.phase='recovery-guard';const r=recovery as Record<string,unknown>;
   const keys=['expectedVersionId','expectedStateToken','expectedDeploymentId','quiescenceConfirmed'];
   if(!r||Array.isArray(r)||typeof r!=='object'||Object.keys(r).length!==keys.length||keys.some(k=>!(k in r))||r.quiescenceConfirmed!==true||!this.stateToken(state)||(!pending&&state.unresolvedSince===undefined)||r.expectedVersionId!==current.version||r.expectedStateToken!==this.stateToken(state)||!stable.includes(status)||deployments.length!==1||deployments[0].status!=='PRIMARY'||deployments[0].id!==r.expectedDeploymentId||!['COMPLETED','FAILED'].includes(deployments[0].rolloutState||''))throw new Error('recovery preconditions no longer match');
  }
  const primary=deployments.length===1?deployments[0]:undefined;
  const proven=stable.includes(status)&&primary&&primary.status==='PRIMARY'&&primary.rolloutState==='COMPLETED'&&tasks.length>=desired&&desired>0&&tasks.every(t=>t.startedBy===primary.id&&this.matches(logs.get(t.taskArn),current));
  if(proven){state.deployed=current.version;delete state.pending;delete state.unresolvedSince;delete state.recoveryToken;state.result='completed';await this.save(state);return;}
  if(recovery!==undefined){await this.request(current,state,deployments);return;}
  // A newer certificate does not retire an older uncertain write-ahead intent.
  if(pending){
   let deployment=deployments.find(d=>d.id===pending.deploymentId);
   if(!deployment&&pending.deploymentId==null){const candidates=deployments.filter(d=>d.status==='PRIMARY'&&!pending.beforeDeploymentIds?.includes(d.id)&&d.createdAt!==undefined&&seconds(d.createdAt)>=(state.attemptedAt??this.now));if(candidates.length===1){deployment=candidates[0];pending.deploymentId=deployment.id;}}
   if(deployment?.rolloutState==='FAILED')await this.unresolved(state,'failed',true);
   else if(deployment)await this.unresolved(state,'awaiting-rollout-and-logs');
   else await this.unresolved(state,pending.deploymentId==null?'ambiguous':'replaced');return;
  }
  if(!stable.includes(status)||!primary||primary.status!=='PRIMARY'||primary.rolloutState!=='COMPLETED'){await this.unresolved(state,'deferred');return;}
  if(this.metrics.UnknownTasks){await this.unresolved(state,'awaiting-logs');return;}
  await this.request(current,state,deployments);
 }
 async run(mode: string,force=false,staging=false,recovery?: unknown) {
  if(!['bootstrap','scheduled','reconcile'].includes(mode)||(staging&&mode!=='bootstrap')||(mode==='reconcile'&&(force||recovery==null)))throw new Error('invalid invocation mode');
  if(mode==='scheduled')this.metrics.Heartbeat=1;
  try {
   this.phase='token';const token=await this.io.token();this.phase='account';await this.io.account(mode==='bootstrap',staging);
   this.phase='read-certificate';let current=await this.io.current(staging);if(current)this.metrics.CurrentDays=this.days(current.meta);
   if(mode==='bootstrap'){if(!current||force||this.days(current.meta)<=this.renewalDays){this.phase='issue';await this.publish(current,await this.io.issue(token,true,staging),staging);}return;}
   this.phase='load-state';const state=await this.io.loadState();const observation=await this.observe(current);
   if(mode==='reconcile'){if(!current)throw new Error('recovery requires current');await this.apply(current,state,observation,recovery);return;}
   let renewed=false;
   if(!current||force||this.days(current.meta)<=this.renewalDays){this.phase='issue';current=await this.publish(current,await this.io.issue(token,false,false),false);this.metrics.CurrentDays=this.days(current.meta);renewed=true;}
   if(current&&(renewed||state.pending||current.version!==state.deployed||this.metrics.MismatchTasks||this.metrics.UnknownTasks))await this.apply(current,state,observation);
  }catch(error){const metric:Record<string,string>={token:'TokenFailure',account:'AccountFailure',observe:'ObserveFailure',validate:'ValidationFailure','read-certificate':'ValidationFailure',store:'StorageFailure',promote:'StorageFailure','save-state':'StorageFailure','load-state':'StorageFailure',deploy:'DeployRequestFailure','recovery-guard':'ApplyFailure',apply:'ApplyFailure'};this.metrics[metric[this.phase]||'IssueFailure']=1;console.log(JSON.stringify({event:'issuer-failure',stage:this.phase,errorType:safeErrorType(error)}));throw error;}
  finally{await this.io.metrics(this.metrics);}
 }
}
