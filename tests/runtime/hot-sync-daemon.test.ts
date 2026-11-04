import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { ensureRuntimeHomeLayout, saveProfile, saveSecret, saveRuntimeConfig, loadRuntimeConfig, loadDaemonState } from "../../src/runtime/runtime-persistence";
import { LocalRuntimeClient } from "../../src/runtime/local-client";

// Uses the compiled release entry point in separate processes, including SIGKILL.
describe("hot sync daemon ownership and crash recovery",()=>{
	it("persists capture before acknowledgment and restores local hook context after a hard restart",async()=>{
		const home=mkdtempSync(path.join(tmpdir(),"xhd-hot-daemon-")),paths=ensureRuntimeHomeLayout(home),key=generateSecretKey();
		saveProfile(paths,{name:"default",apiBase:"http://127.0.0.1:9",npub:nip19.npubEncode(getPublicKey(key)),memoryMode:"assist",workspaceScope:"repo",features:{feedback:false,relay:false,coldSync:false,autoWarmPromotion:false},secureStoreMode:"file",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
		saveSecret(paths,"default",{nsec:nip19.nsecEncode(key),session:null});saveRuntimeConfig(paths,{...loadRuntimeConfig(paths),defaultProfile:"default"});
		let child:ChildProcess|null=null,ended:Promise<void>=Promise.resolve(),stderr="";
		const start=async()=>{
			stderr="";child=spawn(process.execPath,[path.resolve("dist/runtime/daemon.js"),"serve","--home",home],{env:{PATH:process.env.PATH,CROSSHEAD_HOT_SYNC_ENABLED:"true"},stdio:["ignore","ignore","pipe"]});
			child.stderr!.on("data",b=>stderr+=b.toString());ended=new Promise((resolve,reject)=>{child!.once("exit",()=>resolve());child!.once("error",reject);});
			for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(stderr);const state=loadDaemonState(paths);if(state.status==="running"&&state.pid===child.pid&&state.port){const r=await fetch(`http://127.0.0.1:${state.port}/health`,{headers:{"x-onlybots-local-token":state.controlToken}}).catch(()=>null);if(r?.ok)return state;}await new Promise(r=>setTimeout(r,30));}
			throw new Error("daemon readiness timed out: "+stderr);
		};
		const stop=async()=>{if(child?.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await ended;};
		try{
			let state=await start();const client=new LocalRuntimeClient({home});
			const unauth=await fetch(`http://127.0.0.1:${state.port}/v1/memory/hot-sync/control`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"reset",scope:"codex"})});expect(unauth.status).toBe(401);
			await client.hotSyncControl({action:"link",root:"/project",name:"demo"});
			await client.emitEvent({eventId:"durable",runtime:"codex",type:"turn.completed",workspaceId:"repo:/project",payload:{goal:"repair database",summary:"Use the serializable transaction for the account update."}});
			expect((await client.hotSyncControl({action:"status"})).pendingCount).toBe(1);
			await stop();state=await start();
			const timings:number[]=[];
			for(const runtime of ["claude-code","codex","pi"]){const t=performance.now();const turn=await client.emitEvent({eventId:`resume-${runtime}`,runtime,type:"turn.started",workspaceId:"repo:/project",payload:{goal:"continue database repair"}});timings.push(performance.now()-t);expect(JSON.stringify(turn.contextPack)).toContain("Use the serializable transaction for the account update.");}
			const status=await client.status();expect(status.hotSync?.pendingCount).toBe(1);
			const sync=await client.hotSyncControl({action:"status"}),scope=(sync.scopes as Array<{scope:string}>)[0]!.scope;
			await client.hotSyncControl({action:"reset",scope});
			const cleared=await client.emitEvent({eventId:"after-reset",runtime:"codex",type:"turn.started",workspaceId:"repo:/project",payload:{goal:"continue"}});expect(JSON.stringify(cleared.contextPack)).not.toContain("serializable transaction");
			expect((await client.hotSyncControl({action:"status"})).scopes).toEqual(expect.arrayContaining([expect.objectContaining({pendingReset:true})]));
			console.info("offline daemon hook latency ms",timings.map(x=>x.toFixed(2)).join(", "));
		}finally{await stop();rmSync(home,{recursive:true,force:true});}
	},20000);
});
