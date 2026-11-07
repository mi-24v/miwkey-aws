/** AWS boundary. Remote bodies, secret values and private keys never enter application logs. */
import {randomUUID} from 'node:crypto';
import {SecretsManagerClient,GetSecretValueCommand,PutSecretValueCommand,UpdateSecretVersionStageCommand} from '@aws-sdk/client-secrets-manager';
import {SSMClient,GetParameterCommand,PutParameterCommand} from '@aws-sdk/client-ssm';
import {ECSClient,ECSClientConfig,UpdateServiceCommand,DescribeServicesCommand,ListTasksCommand,DescribeTasksCommand} from '@aws-sdk/client-ecs';
import {CloudFormationClient,DescribeStacksCommand} from '@aws-sdk/client-cloudformation';
import {CloudWatchLogsClient,FilterLogEventsCommand} from '@aws-sdk/client-cloudwatch-logs';
import {CloudWatchClient,PutMetricDataCommand} from '@aws-sdk/client-cloudwatch';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {Bundle,metadata} from './certificate';
import {DeploymentRejected,IO,Current,State,Task,Startup,Deployment} from './workflow';
import {Cloudflare} from './dns';
import {bootstrapAccount,restore,issue} from './acme';
const errorCode=(e:unknown)=>e&&typeof e==='object'&&'name'in e?String(e.name):'';
const sdk=()=>({maxAttempts:3,requestHandler:new NodeHttpHandler({connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true})});
export const updateClientOptions=():ECSClientConfig=>({...sdk(),maxAttempts:1});
interface Clients {secrets:SecretsManagerClient;ssm:SSMClient;ecs:ECSClient;update:ECSClient;cfn:CloudFormationClient;logs:CloudWatchLogsClient;cw:CloudWatchClient}
export class AwsIO implements IO {
 readonly clients:Clients;staging=false;api?:Cloudflare;accountState?:string;
 constructor(readonly config:Record<string,string|undefined>,clients:Partial<Clients>={}){
  this.clients={secrets:clients.secrets||new SecretsManagerClient(sdk()),ssm:clients.ssm||new SSMClient(sdk()),ecs:clients.ecs||new ECSClient(sdk()),update:clients.update||new ECSClient(updateClientOptions()),cfn:clients.cfn||new CloudFormationClient(sdk()),logs:clients.logs||new CloudWatchLogsClient(sdk()),cw:clients.cw||new CloudWatchClient(sdk())};
 }
 cfg(name:string):string{const value=this.config[name];if(!value)throw new Error('issuer configuration missing');return value;}
 secret(kind:string,staging=false){return this.cfg((staging?'STAGING_':'')+kind+'_SECRET');}
 async readSecret(name:string,optional=false,version:{VersionId?:string;VersionStage?:string}={}) {
  try{return await this.clients.secrets.send(new GetSecretValueCommand({SecretId:name,...version}));}
  catch(e){if(optional&&errorCode(e)==='ResourceNotFoundException')return null;throw e;}
 }
 async token():Promise<string>{
  const value=await this.readSecret(this.cfg('TOKEN_SECRET'),false,{VersionStage:'AWSCURRENT'});const token=value?.SecretString;
  if(!token||token.includes('\n'))throw new Error('invalid Cloudflare token');
  this.api=new Cloudflare(this.cfg('ZONE_ID'),token);await this.api.check();return token;
 }
 async account(bootstrap:boolean,staging:boolean):Promise<void>{
  const name=this.secret('ACCOUNT',staging);const value=await this.readSecret(name,true,{VersionStage:'AWSCURRENT'});
  if(value?.SecretString){restore(value.SecretString,staging);this.accountState=value.SecretString;}
  else if(bootstrap){this.accountState=await bootstrapAccount(staging,this.cfg('ACCOUNT_EMAIL'));await this.clients.secrets.send(new PutSecretValueCommand({SecretId:name,SecretString:this.accountState,ClientRequestToken:randomUUID()}));}
  else throw new Error('ACME account needs explicit bootstrap');
 }
 async current(staging=false):Promise<Current|null>{
  this.staging=staging;const value=await this.readSecret(this.secret('CERT',staging),true,{VersionStage:'AWSCURRENT'});
  if(!value)return null;if(!value.SecretString||!value.VersionId)throw new Error('certificate unavailable');const payload=JSON.parse(value.SecretString) as Bundle;
  return {version:value.VersionId,value:payload,meta:metadata(payload)};
 }
 async issue(_token:string,_bootstrap:boolean,staging:boolean):Promise<Bundle>{
  if(!this.api||!this.accountState)throw new Error('issuer not initialized');return issue(this.accountState,staging,this.api,this.cfg('FQDN'));
 }
 async putCandidate(value:Bundle,current:Current|null,staging:boolean):Promise<string>{
  const result=await this.clients.secrets.send(new PutSecretValueCommand({SecretId:this.secret('CERT',staging),SecretString:JSON.stringify(value),ClientRequestToken:randomUUID(),...(current?{VersionStages:['AWSPENDING']}:{})}));
  if(!result.VersionId)throw new Error('candidate version unavailable');return result.VersionId;
 }
 async readCandidate(version:string,staging:boolean):Promise<Bundle>{const result=await this.readSecret(this.secret('CERT',staging),false,{VersionId:version,VersionStage:'AWSPENDING'});if(!result?.SecretString)throw new Error('candidate unavailable');return JSON.parse(result.SecretString) as Bundle;}
 async promote(version:string,old:string):Promise<void>{
  await this.clients.secrets.send(new UpdateSecretVersionStageCommand({SecretId:this.secret('CERT',this.staging),VersionStage:'AWSCURRENT',MoveToVersionId:version,RemoveFromVersionId:old}));
  await this.clients.secrets.send(new UpdateSecretVersionStageCommand({SecretId:this.secret('CERT',this.staging),VersionStage:'AWSPENDING',RemoveFromVersionId:version}));
 }
 async loadState():Promise<State>{
  try{const result=await this.clients.ssm.send(new GetParameterCommand({Name:this.cfg('STATE_PARAMETER')}));if(!result.Parameter?.Value)throw new Error('state unavailable');return JSON.parse(result.Parameter.Value) as State;}
  catch(e){if(errorCode(e)==='ParameterNotFound')return {};throw e;}
 }
 async saveState(state:State):Promise<void>{
  await this.clients.ssm.send(new PutParameterCommand({Name:this.cfg('STATE_PARAMETER'),Value:JSON.stringify(state),Type:'String',Overwrite:true}));
  console.log(JSON.stringify({event:'deployment-state',result:state.result??null,currentVersionId:state.current??null,deployedVersionId:state.deployed??null,requestedVersionId:state.pending?.version??null,deploymentId:state.pending?.deploymentId??null}));
 }
 async observe():Promise<[string,Deployment[],Task[],Startup[],number]>{
  const stack=await this.clients.cfn.send(new DescribeStacksCommand({StackName:this.cfg('STACK')}));const status=stack.Stacks?.[0]?.StackStatus;if(!status)throw new Error('stack unavailable');
  const response=await this.clients.ecs.send(new DescribeServicesCommand({cluster:this.cfg('CLUSTER'),services:[this.cfg('SERVICE')]}));
  if(response.failures?.length||response.services?.length!==1)throw new Error('extension service unavailable');const service=response.services[0];
  const arns:string[]=[];let nextToken:string|undefined;
  do{const page=await this.clients.ecs.send(new ListTasksCommand({cluster:this.cfg('CLUSTER'),serviceName:this.cfg('SERVICE'),desiredStatus:'RUNNING',nextToken}));arns.push(...page.taskArns||[]);nextToken=page.nextToken;}while(nextToken);
  const tasks:Task[]=[];
  for(let start=0;start<arns.length;start+=100){const page=await this.clients.ecs.send(new DescribeTasksCommand({cluster:this.cfg('CLUSTER'),tasks:arns.slice(start,start+100)}));if(page.failures?.length)throw new Error('task inventory incomplete');for(const task of page.tasks||[]){if(task.lastStatus==='RUNNING'&&task.taskArn)tasks.push({taskArn:task.taskArn,startedBy:task.startedBy});}}
  const records:Startup[]=[];
  for(const task of tasks){
   let nextToken:string|undefined;
   try{do{
    const page=await this.clients.logs.send(new FilterLogEventsCommand({logGroupName:'/ecs/miwkey-extension/app',logStreamNames:['app/app/'+task.taskArn.split('/').pop()],filterPattern:'"tls certificate loaded"',nextToken}));
    for(const event of page.events||[]){try{
     const line=JSON.parse(event.message||'');const {certFingerprintSha256:fingerprint,certNotAfter:notAfter,secretVersionId:versionId}=line;
     if(line.msg==='tls certificate loaded'&&line.taskArn===task.taskArn&&typeof fingerprint==='string'&&/^[a-f0-9]{64}$/.test(fingerprint)&&typeof notAfter==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(notAfter)&&Number.isFinite(Date.parse(notAfter))&&typeof versionId==='string')records.push({taskArn:task.taskArn,versionId,fingerprint,notAfter});
    }catch{/* Ignore malformed or unrelated startup records. */}}
    nextToken=page.nextToken;
   }while(nextToken);}catch(e){if(errorCode(e)!=='ResourceNotFoundException')throw e;}
  }
  const deployments=(service.deployments||[]).map(d=>{if(!d.id)throw new Error('deployment ID unavailable');return {id:d.id,status:d.status,rolloutState:d.rolloutState,createdAt:d.createdAt};});
  if(service.desiredCount===undefined)throw new Error('desired count unavailable');return [status,deployments,tasks,records,service.desiredCount];
 }
 async deploy():Promise<string>{
  try{const response=await this.clients.update.send(new UpdateServiceCommand({cluster:this.cfg('CLUSTER'),service:this.cfg('SERVICE'),forceNewDeployment:true}));const id=response.service?.deployments?.find(d=>d.status==='PRIMARY')?.id;if(!id)throw new Error('deployment response ambiguous');return id;}
  catch(e){if(['AccessDeniedException','InvalidParameterException','ClientException','ServiceNotActiveException','ClusterNotFoundException','ServiceNotFoundException','ThrottlingException'].includes(errorCode(e)))throw new DeploymentRejected();throw e;}
 }
 async metrics(data:Record<string,number>):Promise<void>{await this.clients.cw.send(new PutMetricDataCommand({Namespace:'Miwkey/ExtensionCertificate',MetricData:Object.entries(data).map(([MetricName,Value])=>({MetricName,Value}))}));}
}
