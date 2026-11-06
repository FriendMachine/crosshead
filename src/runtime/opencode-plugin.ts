import { execFile } from "child_process";
import path from "path";
import { NATIVE_HOST_WARNING, type dispatchNativeHostEvent, type NativeHostEvent, type NativeHostTurn } from "./native-host-hook";
import type { NativeHostConfig } from "./native-host-adapter";

type Part = { type: string; text?: string; synthetic?: boolean; ignored?: boolean };
type Message = { info: { id: string; role: string; parentID?: string; error?: unknown; time?: { completed?: number } }; parts: Part[] };
type PluginInput = { directory: string; client: { session: {
  messages(input: { path: { id: string }; query: { directory: string }; signal: AbortSignal }): Promise<{ data?: Message[]; error?: unknown }>;
} } };
type TurnState = { turn: NativeHostTurn; prepared: Promise<string>; captured: boolean; completion?: Promise<void> };
const text = (parts: Part[]): string => parts.filter(p => p.type === "text" && !p.ignored && !p.synthetic).map(p => p.text ?? "").join("\n").slice(0, 16_384);
type Dispatch = typeof dispatchNativeHostEvent;

// OpenCode runs in Bun (often a compiled binary): process.execPath there is
// OpenCode itself. Always dispatch through the Node selected at installation.
const dispatchFromOpenCode: Dispatch = async (config, event, turn) => new Promise((resolve, reject) => {
  const child = execFile(config.nodeExecutable, [path.join(__dirname, "native-host-hook.js"), "--host", "opencode", "--home", config.runtimeHome],
    { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 262_144 }, (error, stdout) => {
      if (error) { reject(new Error("Crosshead hook unavailable")); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.ok !== true) throw new Error("Crosshead hook unavailable");
        resolve(result);
      } catch { reject(new Error("Crosshead hook unavailable")); }
    });
  child.stdin?.on("error", () => {});
  child.stdin?.end(JSON.stringify({ ...turn, event }));
});

/** Uses OpenCode's native hooks. No SDK dependency or provider credentials. */
export const createOpenCodePlugin = async (input: PluginInput, config: NativeHostConfig, dispatch: Dispatch = dispatchFromOpenCode) => {
  const sessions = new Map<string, TurnState>();
  const pending = new Map<string, TurnState>();
  const key = (turn: NativeHostTurn) => JSON.stringify([turn.sessionId, turn.turnId]);
  const send = async (event: NativeHostEvent, turn: NativeHostTurn): Promise<Record<string, unknown>> => {
    try { return await dispatch(config, event, turn); }
    catch {
      console.error("Crosshead lifecycle delivery unavailable; run crosshead doctor");
      return { ok: false, contextText: NATIVE_HOST_WARNING };
    }
  };
  const history = async (id: string) => {
    const result = await input.client.session.messages({ path: { id }, query: { directory: input.directory }, signal: AbortSignal.timeout(5_000) });
    if (result.error || !Array.isArray(result.data)) throw new Error("OpenCode history unavailable");
    return result.data;
  };
  const prepare = async (sessionID: string, message: Message): Promise<TurnState> => {
    const previous = sessions.get(sessionID);
    const known = pending.get(JSON.stringify([sessionID, message.info.id]));
    if (known) return known;
    if (previous?.turn.turnId === message.info.id) return previous;
    // Event hooks may still be capturing the preceding turn when a user sends another.
    if (previous?.completion) await previous.completion;
    const turn: NativeHostTurn = { workspaceRoot: input.directory, sessionId: sessionID, turnId: message.info.id, prompt: text(message.parts).slice(0, 8192) };
    const state: TurnState = { turn, captured: false, prepared: send("prepare", turn).then(result => {
      if (typeof result.packId === "string") turn.packId = result.packId;
      return typeof result.contextText === "string" ? result.contextText : "";
    }) };
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value!);
    if (pending.size >= 1024) {
      pending.delete(pending.keys().next().value!);
      console.error("Crosshead pending turn limit reached; an uncaptured turn was discarded");
    }
    sessions.set(sessionID, state);
    pending.set(key(turn), state);
    return state;
  };
  const current = async (id: string) => {
    const messages = await history(id);
    const user = [...messages].reverse().find(m => m.info.role === "user" && text(m.parts).trim());
    return user ? prepare(id, user) : undefined;
  };
  const finishState = async (id: string, state: TurnState, messages: Message[], failed: boolean) => {
    if (state.captured) return;
    if (state.completion) return state.completion;
    state.completion = (async () => {
      await state.prepared;
      const replies = messages.filter(m => m.info.role === "assistant" && m.info.parentID === state.turn.turnId);
      const errored = (failed && sessions.get(id) === state) || replies.some(m => Boolean(m.info.error));
      if (!errored && !replies.some(m => m.info.time?.completed)) return;
      const summary = errored ? "OpenCode turn failed or was interrupted; completion was not confirmed."
        : replies.map(m => text(m.parts)).filter(Boolean).join("\n").slice(0, 16_384);
      if (!summary) return;
      const result = await send(errored ? "failed" : "complete", { ...state.turn, summary });
      state.captured = result.ok === true;
      if (state.captured) pending.delete(key(state.turn));
    })().finally(() => { state.completion = undefined; });
    return state.completion;
  };
  const finish = async (id: string, failed: boolean) => {
    const states = [...pending.values()].filter(state => state.turn.sessionId === id);
    if (!states.length) return;
    const messages = await history(id);
    for (const state of states) await finishState(id, state, messages, failed);
  };
  return {
    "chat.message": async (event: { sessionID: string }, output: { message: Message["info"]; parts: Part[] }) => { await prepare(event.sessionID, { info: output.message, parts: output.parts }); },
    "experimental.chat.system.transform": async (event: { sessionID?: string }, output: { system: string[] }) => {
      if (!event.sessionID) return;
      try {
        const state = sessions.get(event.sessionID) ?? await current(event.sessionID);
        const context = state ? await state.prepared : "";
        if (context && !output.system.includes(context)) output.system.push(context);
      } catch { if (!output.system.includes(NATIVE_HOST_WARNING)) output.system.push(NATIVE_HOST_WARNING); }
    },
    "experimental.session.compacting": async (event: { sessionID: string }, _output: { context: string[] }) => {
      const state = sessions.get(event.sessionID);
      if (state) await send("compact-started", state.turn);
    },
    event: async ({ event }: { event: { type: string; properties: { sessionID?: string; info?: { id: string }; status?: { type: string } } } }) => {
      const id = event.properties.sessionID ?? event.properties.info?.id;
      if (!id) return;
      try {
        if (event.type === "session.idle" || (event.type === "session.status" && event.properties.status?.type === "idle")) await finish(id, false);
        if (event.type === "session.error") await finish(id, true);
        if (event.type === "session.compacted") {
          const state = sessions.get(id);
          if (state) await send("compact-completed", state.turn);
        }
        if (event.type === "session.deleted") {
          await finish(id, false);
          sessions.delete(id);
          for (const [pendingKey, state] of pending) if (state.turn.sessionId === id) pending.delete(pendingKey);
        }
      } catch { console.error("Crosshead turn capture unavailable; run crosshead doctor"); }
    },
    dispose: async () => { await Promise.allSettled([...pending.values()].map(state => state.completion)); sessions.clear(); pending.clear(); },
  };
};
