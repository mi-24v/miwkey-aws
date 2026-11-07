import {Engine,IO} from './workflow';
import {AwsIO} from './aws';
import {productionValidate,stagingValidate} from './certificate';
/** Injectable AWS boundary; production and tests use the same invocation validation. */
export async function invoke(event:unknown,environment:Record<string,string|undefined>,factory:()=>IO=()=>new AwsIO(environment)):Promise<{result:string}>{
 try{
  if(!event||Array.isArray(event)||typeof event!=='object')throw new Error('invalid invocation');
  const e=event as Record<string,unknown>;if(Object.keys(e).some(k=>!['mode','force','staging','recovery'].includes(k)))throw new Error('invalid invocation');
  const mode=e.mode,force=e.force===undefined?false:e.force,staging=e.staging===undefined?false:e.staging;
  if(typeof mode!=='string'||!['bootstrap','scheduled','reconcile'].includes(mode)||typeof force!=='boolean'||typeof staging!=='boolean'||(staging&&mode!=='bootstrap')||(mode==='reconcile'&&(force||e.recovery==null)))throw new Error('invalid invocation');
  const fqdn=environment.FQDN;const renewalDays=Number(environment.RENEWAL_DAYS);if(!fqdn||!Number.isFinite(renewalDays)||renewalDays<=0)throw new Error('invalid issuer configuration');
  const io=factory();const engine=new Engine(io,(value,rehearsal)=>(rehearsal?stagingValidate:productionValidate)(value,fqdn),undefined,renewalDays);
  await engine.run(mode,force,staging,e.recovery);console.log(JSON.stringify({result:'invocation-complete',mode,staging}));return {result:'complete'};
 }catch{console.log('{"result":"invocation-failed"}');throw new Error('certificate issuer failed; inspect non-secret state and metrics');}
}
export const handler=(event:unknown)=>invoke(event,process.env);
