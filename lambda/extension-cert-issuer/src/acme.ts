/** Bootstrap-only account registration and bounded low-level ACME orchestration. */
import * as acme from 'acme-client';
import {createPrivateKey, JsonWebKey} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Cloudflare, DnsLifecycle} from './dns';
import {Bundle,assertValidPrivateKey} from './certificate';
// Both debug and callback loggers can include remote response bodies.
(require('debug') as {disable():string}).disable();
acme.setLogger(()=>{});
export const directories=['https://acme-v02.api.letsencrypt.org/directory','https://acme-staging-v02.api.letsencrypt.org/directory'];
type Factory=(opts:acme.ClientOptions)=>acme.Client;
const createClient:Factory=opts=>new acme.Client(opts);
interface AccountState {directory:string;key:JsonWebKey;account_url:string}
function configure(signal?:AbortSignal) {
 acme.axios.defaults.timeout=15000;acme.axios.defaults.maxRedirects=0;acme.axios.defaults.proxy=false;acme.axios.defaults.signal=signal;
 (acme.axios.defaults as unknown as {acmeSettings:{retryMaxAttempts:number}}).acmeSettings.retryMaxAttempts=0;
}
export function restore(state:string,staging:boolean,signal?:AbortSignal,factory:Factory=createClient):acme.Client {
 try{
  const value=JSON.parse(state) as AccountState;const directory=directories[Number(staging)];const url=new URL(value.account_url);
  if(value.directory!==directory||url.origin!==new URL(directory).origin||url.protocol!=='https:'||!url.pathname.startsWith('/acme/acct/')||url.search||url.hash||url.username||url.password)throw new Error();
  // gufo 0.7.0 serializes JWKRSA fields without kty. Only a complete RSA private JWK may use that legacy shape.
  const jwk=value.key;
  if(jwk.kty===undefined&&['n','e','d','p','q','dp','dq','qi'].every(k=>typeof jwk[k]==='string'&&jwk[k]!.length>0))jwk.kty='RSA';
  if(jwk.kty!=='RSA')throw new Error();
  const key=createPrivateKey({key:jwk,format:'jwk'});
  // Import and even a sign/verify round-trip can accept inconsistent RSA/CRT fields.
  // Validate using the pinned native implementation; key material stays in stdin/memory.
  assertValidPrivateKey(key);const accountKey=key.export({type:'pkcs8',format:'pem'});
  configure(signal);return factory({directoryUrl:directory,accountKey,accountUrl:value.account_url,backoffAttempts:6,backoffMin:1000,backoffMax:5000});
 }catch{throw new Error('ACME account environment mismatch');}
}
export async function bootstrapAccount(staging:boolean,email:string,factory:Factory=createClient):Promise<string>{
 const accountKey=await acme.crypto.createPrivateRsaKey();configure(AbortSignal.timeout(600000));
 const client=factory({directoryUrl:directories[Number(staging)],accountKey,backoffAttempts:6,backoffMin:1000,backoffMax:5000});
 await client.createAccount({termsOfServiceAgreed:true,contact:['mailto:'+email]});
 return JSON.stringify({directory:directories[Number(staging)],key:createPrivateKey(accountKey).export({format:'jwk'}),account_url:client.getAccountUrl()});
}
// Poll only pending protocol states. HTTP errors are never retried here.
async function waitValid<T extends {status:string}>(poll:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 let delay=1000;
 for(;;){
  signal.throwIfAborted();const item=await poll();signal.throwIfAborted();
  if(item.status==='valid')return item;
  if(!['pending','processing','ready'].includes(item.status))throw new Error('ACME status failed');
  await sleep(delay,undefined,{signal});delay=Math.min(delay*2,5000);
 }
}
interface Options {clientFactory?:Factory;lifecycleFactory?:()=>Pick<DnsLifecycle,'fulfill'|'cleanup'>;timeoutMs?:number}
export async function issue(state:string,staging:boolean,api:Cloudflare,fqdn:string,options:Options={}):Promise<Bundle>{
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),options.timeoutMs??600000);
 const life=options.lifecycleFactory?.()||new DnsLifecycle(api);
 const signal=abort.signal;
 try{
  const client=restore(state,staging,signal,options.clientFactory);
  const key=await acme.crypto.createPrivateEcdsaKey('P-256');
  const [,csr]=await acme.crypto.createCsr({commonName:fqdn,altNames:[fqdn]},key);
  signal.throwIfAborted();const order=await client.createOrder({identifiers:[{type:'dns',value:fqdn}]});
  const authorizations=await client.getAuthorizations(order);
  if(authorizations.length!==1)throw new Error('unexpected authorization count');
  for(const authz of authorizations){
   signal.throwIfAborted();if(authz.identifier.type!=='dns'||authz.identifier.value!==fqdn||authz.wildcard)throw new Error('unexpected authorization');
   if(authz.status==='valid')continue;
   const challenge=authz.challenges.find(c=>c.type==='dns-01');if(!challenge)throw new Error('DNS challenge missing');
   // acme-client returns the already-hashed base64url DNS-01 value.
   await life.fulfill(fqdn,await client.getChallengeKeyAuthorization(challenge),signal);
   signal.throwIfAborted();await client.completeChallenge(challenge);
   await waitValid(async()=>{const items=await client.getAuthorizations(order);if(items.length!==1||items[0].identifier.type!=='dns'||items[0].identifier.value!==fqdn||items[0].wildcard)throw new Error('unexpected authorization');return items[0];},signal);
  }
  signal.throwIfAborted();const finalized=await client.finalizeOrder(order,csr);
  signal.throwIfAborted();const validOrder=await waitValid(()=>client.getOrder(finalized),signal);
  signal.throwIfAborted();const certificatePem=await client.getCertificate(validOrder);signal.throwIfAborted();
  return {certificatePem,privateKeyPem:key.toString()};
 }finally{clearTimeout(timer);await life.cleanup();}
}
