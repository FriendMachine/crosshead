#!/usr/bin/env node
// Disposable production customer identity only. State artifacts contain signed
// synthetic memory, never the private key or bearer tokens.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {HotSyncManager}=require('../dist/runtime/hot-sync-manager.js');
const {HostedOnlyBotsClient}=require('../dist/runtime/hosted-client.js');
const {generateSecretKey,getPublicKey,nip19}=require('nostr-tools');
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const phase=option('--phase'),home=path.resolve(option('--home','fixture-state')),run=option('--run-id');
const origin='https://crosshead.sh',profileName=`hn-fixture-${run}`,workspace='repo:/synthetic-crosshead-project';
assert(run&&process.argv.includes('--allow-production'),'Explicit run ID and --allow-production required');
const nsec=process.env.CROSSHEAD_HN_FIXTURE_NSEC;assert(nsec,'Missing purpose-owned synthetic identity');
const decoded=nip19.decode(nsec);assert.equal(decoded.type,'nsec');
const npub=nip19.npubEncode(getPublicKey(decoded.data));
mkdirSync(home,{recursive:true,mode:0o700});
const privatize=dir=>{chmodSync(dir,0o700);for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);assert(!e.isSymbolicLink(),'Fixture artifacts must not contain symlinks');if(e.isDirectory())privatize(p);else chmodSync(p,0o600);}};privatize(home);
const originalFetch=globalThis.fetch;let offline=false;
globalThis.fetch=(...args)=>offline?Promise.reject(new Error('fixture offline transport')):originalFetch(...args);
const clients=[],managers=[],checks=[];
const make=(stateDir=home,key=nsec,name=profileName)=>{
 const d=nip19.decode(key),pub=nip19.npubEncode(getPublicKey(d.data)),client=new HostedOnlyBotsClient({apiBase:origin,npub:pub,nsec:key});
 const m=new HotSyncManager({stateDir,origin,npub:pub,nsec:key,profileName:name},client);m.link('/synthetic-crosshead-project',`hn-fixture-${run}`);clients.push(client);managers.push(m);return m;
};
const findings=m=>[...new Map(m.read().scopes.flatMap(s=>JSON.parse(s.content).continuityCheckpoints).map(c=>[c.id,c])).values()];
const capture=(m,id)=>{const begin=performance.now();m.capture('codex',{id:`${run}:${id}`,runtime:'codex',workspaceId:workspace,occurredAt:new Date().toISOString(),goal:'Synthetic cross-machine launch acceptance',summary:`Synthetic ${id}; canonical duration zero is valid, negatives rejected.`});return performance.now()-begin;};
const has=(m,id)=>findings(m).some(c=>c.id===`${run}:${id}`);
const sync=async(m,predicate)=>{const deadline=Date.now()+90000;let last;do{try{await m.flush(false);if(predicate())return;}catch(error){last=error;}await new Promise(r=>setTimeout(r,1500));}while(Date.now()<deadline);throw last??new Error('Production convergence deadline exceeded');};
const scope=m=>m.status().scopes.find(s=>s.scope.startsWith('ws-codex-'))?.scope;
let m, primaryFailure=null;
try{
 m=make();
 if(phase==='a-online'){
  capture(m,'a-base');await sync(m,()=>m.status().pendingCount===0);assert(has(m,'a-base'));checks.push('Linux A uploaded signed synthetic finding');
 }else if(phase==='a-offline'){
  assert(has(m,'a-base'));const ms=capture(m,'a-stale');m.tick();const failedBy=Date.now()+30000;while(!m.status().error&&Date.now()<failedBy)await new Promise(r=>setTimeout(r,100));await m.stop();assert.equal(m.status().error,'sync_unavailable');assert.equal(m.status().pendingCount,1);assert(has(m,'a-stale'));checks.push('Docker network disconnected; capture fsynced and remained pending');checks.push(`offline capture ${ms.toFixed(2)} ms`);
 }else if(phase==='b-reconnect-reset'){
  await sync(m,()=>has(m,'a-base'));checks.push('Fresh macOS B recovered Linux A finding from production');
  capture(m,'b-online');await sync(m,()=>m.status().pendingCount===0);
  offline=true;capture(m,'b-offline');await m.stop();m=make();assert(has(m,'b-offline'));assert.equal(m.status().pendingCount,1);checks.push('macOS offline transport capture survived restart');
  offline=false;await sync(m,()=>m.status().pendingCount===0);
  const fresh=make(path.join(home,'fresh-recovery'));await sync(fresh,()=>has(fresh,'b-offline')&&has(fresh,'a-base'));
  const other=make(path.join(home,'other-identity'),nip19.nsecEncode(generateSecretKey()));await sync(other,()=>!other.status().initialSyncPending);assert.equal(findings(other).length,0);
  const otherProfile=make(path.join(home,'other-profile'),nsec,`${profileName}-other`);await sync(otherProfile,()=>!otherProfile.status().initialSyncPending);assert.equal(findings(otherProfile).length,0);checks.push('Fresh recovery and identity/profile isolation verified');
  m.reset(scope(m));await sync(m,()=>!m.status().scopes.some(s=>s.pendingReset));assert.equal(findings(m).length,0);checks.push('macOS reset reached production');
 }else if(phase==='a-recover'){
  assert(has(m,'a-stale'));assert.equal(m.status().pendingCount,1);
  await sync(m,()=>m.status().pendingCount===0);assert(!has(m,'a-stale'));assert.equal(findings(m).length,0);assert(m.status().scopes.some(s=>s.epoch>0&&s.discardedByReset>0));checks.push('Linux stale offline capture discarded after remote reset, without resurrection');
  capture(m,'after-reset');await sync(m,()=>m.status().pendingCount===0);
  const fresh=make(path.join(home,'fresh-after-reset'));await sync(fresh,()=>has(fresh,'after-reset'));assert(!has(fresh,'a-stale'));checks.push('New epoch accepts new work and fresh recovery');
 }else if(phase==='cleanup'){
  await sync(m,()=>!m.status().initialSyncPending);
  for(const row of m.status().scopes){m.reset(row.scope);await sync(m,()=>!m.status().scopes.some(s=>s.pendingReset));}
  assert.equal(findings(m).length,0);checks.push('All purpose-owned production scopes cleared');
 }else throw new Error('Unknown acceptance phase');
 const result={phase,platform:process.platform,run,npub,checks,pending:m.status().pendingCount,scopes:m.status().scopes.map(s=>({scope:s.scope,epoch:s.epoch,revision:s.remoteRevision,discarded:s.discardedByReset}))};
 writeFileSync(path.join(home,`result-${phase}.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){primaryFailure=error;throw error;}finally{
 const failures=[];offline=false;
 const stopped=await Promise.allSettled(managers.map(m=>m.stop()));for(const result of stopped)if(result.status==='rejected')failures.push('manager stop failed');
 for(const [index,client] of clients.entries()){
  const session=client.session();if(!session)continue;
  try{const response=await originalFetch(`${origin}/v1/auth/revoke`,{method:'POST',headers:{authorization:`Bearer ${session.sessionToken}`},signal:AbortSignal.timeout(10000)});const body=await response.json();assert(response.ok&&body.revoked===true);}
  catch{failures.push(`session revocation failed for fixture client ${index}`);}
 }
 globalThis.fetch=originalFetch;
 // Enforce the artifact contract even if transport cleanup failed.
 const inspect=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())inspect(file);else{const content=readFileSync(file,'utf8');assert(!content.includes(nsec)&&!content.includes('nsec1')&&!content.includes('ob_sess_'),'Secret found in fixture artifact');}}};
 try{inspect(home);}catch(error){failures.push(error.message);}
 if(failures.length){console.error('Fixture cleanup failures: '+failures.join('; '));writeFileSync(path.join(home,'cleanup-errors.json'),JSON.stringify({failures},null,2)+'\n');if(!primaryFailure)throw new Error(failures.join('; '));}
}
