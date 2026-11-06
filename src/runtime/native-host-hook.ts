import path from "path";
import { parseArgs } from "./adapter-utils";
import { ensureHookRuntime } from "./hook-runtime";
import { LocalRuntimeClient } from "./local-client";
import { loadNativeHostConfig, NativeHostRuntimeAdapter, type NativeHost, type NativeHostConfig } from "./native-host-adapter";

export const NATIVE_HOST_WARNING = "Crosshead continuity is unavailable for this turn. Do not assume saved memory was loaded or this turn was captured. Run crosshead doctor to diagnose.";
export type NativeHostTurn = { workspaceRoot: string; sessionId: string; turnId: string; prompt: string; summary?: string; packId?: string | null };
export type NativeHostEvent = "prepare" | "complete" | "failed" | "compact-started" | "compact-completed";
export const dispatchNativeHostEvent = async (config: NativeHostConfig, event: NativeHostEvent, input: NativeHostTurn) => {
  if (!input || typeof input.workspaceRoot !== "string" || !path.isAbsolute(input.workspaceRoot) ||
    !input.sessionId || typeof input.sessionId !== "string" || input.sessionId.length > 512 ||
    !input.turnId || typeof input.turnId !== "string" || input.turnId.length > 512 || typeof input.prompt !== "string") throw new Error("Invalid host event");
  await ensureHookRuntime(config.runtimeHome);
  const status = await new LocalRuntimeClient({ home: config.runtimeHome, timeoutMs: 5_000 }).status(config.profileName);
  if (event === "prepare" && status.profile?.memoryMode === "off") return { ok: true, contextText: "", packId: null };
  const adapter = new NativeHostRuntimeAdapter(config);
  const base = { workspaceRoot: path.resolve(input.workspaceRoot), sessionId: input.sessionId, turnId: input.turnId };
  if (event === "prepare") return { ok: true, ...await adapter.prepareTurn({ ...base, prompt: input.prompt.slice(0, 8192) }) };
  if (event === "compact-started" || event === "compact-completed") {
    await (event === "compact-started" ? adapter.compactStarted({ ...base, summary: "Host context compaction started" }) : adapter.compactCompleted({ ...base, summary: "Host context compaction completed" }));
  } else {
    const summary = typeof input.summary === "string" ? input.summary.slice(0, 16_384) : "";
    const request = { ...base, packId: input.packId, goal: input.prompt.slice(0, 8192), summary,
      transcript: [{ role: "user" as const, content: input.prompt.slice(0, 8192) }, { role: "assistant" as const, content: summary }] };
    if (event === "complete") {
      if (summary.trim()) await adapter.completeTurn(request);
    } else if (event === "failed") await adapter.failTurn(request);
    else throw new Error("Unknown host event");
  }
  return { ok: true };
};

export const runNativeHostHook = async (): Promise<void> => {
  try {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.host !== "hermes" && flags.host !== "opencode") throw new Error("Invalid host");
    const host: NativeHost = flags.host;
    const config = loadNativeHostConfig(host, typeof flags.home === "string" ? flags.home : undefined);
    let raw = "";
    for await (const chunk of process.stdin) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 262_144) throw new Error("Host event too large"); }
    const { event, ...input } = JSON.parse(raw) as NativeHostTurn & { event: NativeHostEvent };
    process.stdout.write(JSON.stringify(await dispatchNativeHostEvent(config, event, input)) + "\n");
  } catch {
    // Do not echo provider errors, prompts, credentials, or memory to host logs.
    process.stderr.write("Crosshead plugin could not deliver a lifecycle event; run crosshead doctor.\n");
    process.stdout.write(JSON.stringify({ ok: false, contextText: NATIVE_HOST_WARNING }) + "\n");
    process.exitCode = 1;
  }
};
if (require.main === module) void runNativeHostHook();
