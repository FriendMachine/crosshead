import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as adapterUtils from "../../src/runtime/adapter-utils";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import { createOpenCodePlugin } from "../../src/runtime/opencode-plugin";
import { installNativeHostAdapter, loadNativeHostConfig, nativeHostFiles, NativeHostRuntimeAdapter, uninstallNativeHostAdapter, type NativeHostConfig } from "../../src/runtime/native-host-adapter";
import type { LocalRuntimeClient } from "../../src/runtime/local-client";
import { renderHermesPlugin } from "../../src/runtime/hermes-plugin";
import { NATIVE_HOST_WARNING } from "../../src/runtime/native-host-hook";
import { updateRuntimeAdapterVersion, rollbackRuntimeAdapterVersion } from "../../src/runtime/local-runtime";
import { RUNTIME_ADAPTER_NAMES, listAdapterRecords, resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

const roots: string[] = [];
const temporary = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-native-")); roots.push(dir); return dir; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const config: NativeHostConfig = { marker: "crosshead-native-host-v1", name: "opencode", runtimeHome: "/runtime", hostHome: "/host", profileName: "default", adapterVersion: "0.1.0", hostBinary: "opencode", nodeExecutable: process.execPath };
const user = (id = "user-1", prompt = "Investigate serializer boundary conditions") => ({ info: { id, role: "user" }, parts: [{ type: "text", text: prompt }] });
const answer = (parentID = "user-1", extra = {}) => ({ info: { id: "assistant-1", role: "assistant", parentID, time: { completed: 1 }, ...extra }, parts: [{ type: "text", text: "The serializer must retain nanosecond precision; use a decimal string." }] });
const fixture = async () => {
  let messages = [user(), answer()];
  const dispatch = vi.fn(async (_config, event, _turn) => event === "prepare" ? { ok: true, contextText: "Verified local hot memory", packId: "pack-1" } : { ok: true });
  const read = vi.fn(async () => ({ data: messages }));
  const hooks = await createOpenCodePlugin({ directory: "/project", client: { session: { messages: read } } }, config, dispatch);
  return { hooks, dispatch, read, setMessages: (value: typeof messages) => { messages = value; } };
};
const idle = (id = "session-1") => ({ event: { type: "session.idle", properties: { sessionID: id } } });

describe("native host installation", () => {
  it("keeps runtime configuration in attachment metadata for release-update rollback", async () => {
    const attachAdapter = vi.fn(async () => ({}));
    const adapter = new NativeHostRuntimeAdapter(config, { attachAdapter, emitEvent: vi.fn(async () => ({})) } as unknown as LocalRuntimeClient);
    await adapter.sessionStarted({ workspaceRoot: "/project", sessionId: "s" });
    expect(attachAdapter).toHaveBeenCalledWith(expect.objectContaining({ managedFiles: expect.arrayContaining(["/runtime/config/native-hosts/opencode.json"]) }));
  });
  it("registers OpenCode without modifying user configuration and uninstalls only managed files", async () => {
    const dir = temporary(), home = path.join(dir, "runtime"), hostHome = path.join(dir, "opencode");
    mkdirSync(hostHome);
    const userConfig = path.join(hostHome, "opencode.jsonc");
    writeFileSync(userConfig, "// user settings\n{\"model\":\"custom/local\"}\n");
    const result = await installNativeHostAdapter("opencode", { home, hostHome, profileName: "alice" });
    expect(loadNativeHostConfig("opencode", home)).toMatchObject({ profileName: "alice", hostHome });
    expect(listAdapterRecords(resolveRuntimePaths(home))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "opencode" })]));
    await installNativeHostAdapter("opencode", { home, hostHome, profileName: "alice" });
    expect(readFileSync(result.managedFiles[0]!, "utf8")).toContain("createOpenCodePlugin");
    await uninstallNativeHostAdapter("opencode", home);
    expect(existsSync(result.managedFiles[0]!)).toBe(false);
    expect(readFileSync(userConfig, "utf8")).toContain("// user settings");
    expect(await uninstallNativeHostAdapter("opencode", home)).toEqual([]);
  });
  it("refuses to overwrite an unrelated plugin", async () => {
    const dir = temporary(), hostHome = path.join(dir, "host");
    mkdirSync(path.join(hostHome, "plugins"), { recursive: true });
    const file = path.join(hostHome, "plugins", "crosshead.js");
    writeFileSync(file, "export const UserPlugin = () => ({})");
    await expect(installNativeHostAdapter("opencode", { home: path.join(dir, "runtime"), hostHome })).rejects.toThrow("unmanaged");
    expect(readFileSync(file, "utf8")).toContain("UserPlugin");
  });
  it("rejects symlinked plugin parents and leaves the target unchanged", async () => {
    const dir = temporary(), hostHome = path.join(dir, "host"), outside = path.join(dir, "outside");
    mkdirSync(hostHome); mkdirSync(outside); symlinkSync(outside, path.join(hostHome, "plugins"));
    await expect(installNativeHostAdapter("opencode", { home: path.join(dir, "runtime"), hostHome })).rejects.toThrow("symlink");
    expect(existsSync(path.join(outside, "crosshead.js"))).toBe(false);
  });
  it("rolls back plugin files when Hermes activation fails", async () => {
    const dir = temporary(), home = path.join(dir, "runtime"), hostHome = path.join(dir, "hermes");
    await expect(installNativeHostAdapter("hermes", { home, hostHome, hostBinary: path.join(dir, "missing-hermes") })).rejects.toThrow();
    expect(existsSync(path.join(hostHome, "plugins", "crosshead", "__init__.py"))).toBe(false);
    expect(listAdapterRecords(resolveRuntimePaths(home))).toEqual([]);
  });
  it("registers both hosts for update, status, and rollback snapshots", () => {
    expect(RUNTIME_ADAPTER_NAMES).toEqual(expect.arrayContaining(["hermes", "opencode"]));
  });
  it("updates and rolls back the installed native plugin while retaining its profile and host home", async () => {
    const dir = temporary(), home = path.join(dir, "runtime"), hostHome = path.join(dir, "host");
    await installNativeHostAdapter("opencode", { home, hostHome, profileName: "alice" });
    await updateRuntimeAdapterVersion(home, "opencode", "0.1.1");
    expect(loadNativeHostConfig("opencode", home)).toMatchObject({ adapterVersion: "0.1.1", profileName: "alice", hostHome });
    await rollbackRuntimeAdapterVersion(home, "opencode", "0.1.0");
    expect(loadNativeHostConfig("opencode", home)).toMatchObject({ adapterVersion: "0.1.0", profileName: "alice", hostHome });
  });
  it("rejects changing host homes until the old plugin is uninstalled", async () => {
    const dir = temporary(), home = path.join(dir, "runtime"), hostHome = path.join(dir, "first");
    const result = await installNativeHostAdapter("opencode", { home, hostHome });
    await expect(installNativeHostAdapter("opencode", { home, hostHome: path.join(dir, "second") })).rejects.toThrow("Uninstall");
    expect(existsSync(nativeHostFiles(result.config)[0]!)).toBe(true);
    expect(loadNativeHostConfig("opencode", home).hostHome).toBe(hostHome);
  });
  it("refuses to replace a plugin owned by another runtime home", async () => {
    const dir = temporary(), home = path.join(dir, "alice"), hostHome = path.join(dir, "host");
    const first = await installNativeHostAdapter("opencode", { home, hostHome });
    const original = readFileSync(nativeHostFiles(first.config)[0]!, "utf8");
    await expect(installNativeHostAdapter("opencode", { home: path.join(dir, "bob"), hostHome })).rejects.toThrow("another runtime");
    expect(readFileSync(nativeHostFiles(first.config)[0]!, "utf8")).toBe(original);
  });
  it("refuses to uninstall a marked plugin belonging to another runtime", async () => {
    const dir = temporary();
    const alice = await installNativeHostAdapter("opencode", { home: path.join(dir, "alice"), hostHome: path.join(dir, "alice-host") });
    const bob = await installNativeHostAdapter("opencode", { home: path.join(dir, "bob"), hostHome: path.join(dir, "bob-host") });
    const replacement = readFileSync(nativeHostFiles(bob.config)[0]!, "utf8");
    writeFileSync(nativeHostFiles(alice.config)[0]!, replacement);
    await expect(uninstallNativeHostAdapter("opencode", alice.config.runtimeHome)).rejects.toThrow("another runtime");
    expect(readFileSync(nativeHostFiles(alice.config)[0]!, "utf8")).toBe(replacement);
  });
  it("rolls back host files if writing runtime configuration fails", async () => {
    const dir = temporary(), home = path.join(dir, "runtime"), hostHome = path.join(dir, "host");
    const configFile = path.join(home, "config", "native-hosts", "opencode.json");
    const pluginFile = path.join(hostHome, "plugins", "crosshead.js");
    const writeManagedFile = adapterUtils.writeManagedFile;
    // Inject a real write boundary failure: chmod cannot deny writes to root.
    vi.spyOn(adapterUtils, "writeManagedFile").mockImplementation((file, ...args) => {
      if (file === configFile) {
	expect(readFileSync(pluginFile, "utf8")).toContain("crosshead-native-host-v1");
	throw Object.assign(new Error("EACCES: runtime configuration write denied"), { code: "EACCES" });
      }
      return writeManagedFile(file, ...args);
    });
    await expect(installNativeHostAdapter("opencode", { home, hostHome })).rejects.toThrow("EACCES");
    expect(existsSync(pluginFile)).toBe(false);
    expect(existsSync(configFile)).toBe(false);
    expect(listAdapterRecords(resolveRuntimePaths(home))).toEqual([]);
  });
  it("does not remove a replacement plugin on uninstall", async () => {
    const dir = temporary(), result = await installNativeHostAdapter("opencode", { home: path.join(dir, "runtime"), hostHome: path.join(dir, "host") });
    writeFileSync(nativeHostFiles(result.config)[0]!, "user replacement");
    await expect(uninstallNativeHostAdapter("opencode", result.config.runtimeHome)).rejects.toThrow("unmanaged");
    expect(readFileSync(nativeHostFiles(result.config)[0]!, "utf8")).toBe("user replacement");
  });
});

describe("OpenCode lifecycle", () => {
  it("injects once per provider request and prepares once across tool iterations", async () => {
    const { hooks, dispatch, read } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    const output = { system: ["Existing system instructions"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);
    expect(output.system).toEqual(["Existing system instructions", "Verified local hot memory"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
  it("captures final assistant text and pack attribution once for duplicate idle events", async () => {
    const { hooks, dispatch } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    await Promise.all([hooks.event(idle()), hooks.event(idle())]);
    expect(dispatch.mock.calls.filter(call => call[1] === "complete")).toHaveLength(1);
    expect(dispatch).toHaveBeenLastCalledWith(config, "complete", expect.objectContaining({ packId: "pack-1", turnId: "user-1", summary: expect.stringContaining("nanosecond") }));
  });
  it("captures both queued turns when another prompt arrives before the first idle callback", async () => {
    const { hooks, dispatch, setMessages } = await fixture();
    const second = user("user-2", "Inspect the second boundary");
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: second.info, parts: second.parts });
    setMessages([user(), answer(), second, answer("user-2")]);
    await hooks.event(idle());
    const completed = dispatch.mock.calls.filter(call => call[1] === "complete");
    expect(completed.map(call => call[2].turnId)).toEqual(["user-1", "user-2"]);
  });
  it("retries an unacknowledged capture on the next idle event", async () => {
    const { hooks, dispatch } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    dispatch.mockResolvedValueOnce({ ok: false });
    await hooks.event(idle());
    await hooks.event(idle());
    expect(dispatch.mock.calls.filter(call => call[1] === "complete")).toHaveLength(2);
  });
  it("restores a resumed session from the host's history", async () => {
    const { hooks, dispatch } = await fixture();
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);
    await hooks.event(idle());
    expect(output.system).toContain("Verified local hot memory");
    expect(dispatch.mock.calls.map(call => call[1])).toEqual(["prepare", "complete"]);
  });
  it("never captures a previous turn's response or an unfinished response", async () => {
    const { hooks, dispatch, setMessages } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    setMessages([user(), answer("old-user")]);
    await hooks.event(idle());
    setMessages([user(), answer("user-1", { time: {} })]);
    await hooks.event(idle());
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("records interruptions as failed without persisting provider error text", async () => {
    const { hooks, dispatch, setMessages } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    setMessages([user(), answer("user-1", { error: { message: "secret-provider-header" } })]);
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "session-1" } } });
    expect(dispatch.mock.calls.map(call => call[1])).toEqual(["prepare", "failed"]);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("secret-provider-header");
  });
  it("reports daemon failure to the model while allowing the host to continue", async () => {
    const dispatch = vi.fn(async () => { throw new Error("secret daemon detail"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = await createOpenCodePlugin({ directory: "/project", client: { session: { messages: async () => ({ data: [user()] }) } } }, config, dispatch);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, output);
    expect(output.system).toEqual([NATIVE_HOST_WARNING]);
    expect(JSON.stringify(output)).not.toContain("secret daemon detail");
  });
  it("retains injection across compaction without replacing the host's compaction prompt", async () => {
    const { hooks, dispatch } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    const output = { context: ["Host compaction rules"] };
    await hooks["experimental.session.compacting"]({ sessionID: "session-1" }, output);
    await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "session-1" } } });
    expect(output.context).toEqual(["Host compaction rules"]);
    expect(dispatch.mock.calls.map(call => call[1])).toEqual(["prepare", "compact-started", "compact-completed"]);
    const prompt = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "session-1" }, prompt);
    expect(prompt.system).toContain("Verified local hot memory");
  });
  it("ignores synthetic text and tool outputs when capturing a response", async () => {
    const { hooks, dispatch, setMessages } = await fixture();
    const response = answer();
    response.parts.push({ type: "tool", text: "secret file contents" }, { type: "text", text: "synthetic injected context", synthetic: true } as never);
    setMessages([user(), response]);
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    await hooks.event(idle());
    const capture = JSON.stringify(dispatch.mock.calls.at(-1));
    expect(capture).toContain("nanosecond");
    expect(capture).not.toContain("secret file");
    expect(capture).not.toContain("synthetic injected");
  });
  it("keeps concurrent sessions separate", async () => {
    const { hooks, dispatch } = await fixture();
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: user().info, parts: user().parts });
    const other = user("user-2", "Unrelated second session");
    await hooks["chat.message"]({ sessionID: "session-2" }, { message: other.info, parts: other.parts });
    await hooks.event(idle());
    expect(dispatch).toHaveBeenLastCalledWith(config, "complete", expect.objectContaining({ sessionId: "session-1", turnId: "user-1" }));
  });
});

describe("Hermes hook contract", () => {
  it("registers native callbacks, correlates turns, and captures normal turns carrying an auxiliary capability token", () => {
    const dir = temporary(), file = path.join(dir, "plugin.py");
    // Quotes and shell metacharacters must stay literal in generated argv.
    const nodePath = "/node with 'quotes'/$literal";
    writeFileSync(file, renderHermesPlugin({ ...config, name: "hermes" }, nodePath, "/hook.js"));
    const program = `import runpy, json
p=runpy.run_path(${JSON.stringify(file)})
class Context:
 def __init__(self): self.hooks={}
 def register_hook(self,n,f): self.hooks[n]=f
 def session_cwd(self): return '/actual-session-workspace'
c=Context();p['register'](c)
assert set(c.hooks)=={'pre_llm_call','post_llm_call','on_session_end','api_request_error'}
assert p['_COMMAND'][0]==${JSON.stringify(nodePath)}
events=[]
def send(event,turn):
 events.append((event,dict(turn)));return {'ok':True,'contextText':'verified hot memory','packId':'pack'}
c.hooks['pre_llm_call'].__globals__['_send']=send
r=c.hooks['pre_llm_call']('s',[{'type':'image_url','image_url':'do not capture'},{'type':'text','text':'inspect serializer'}],turn_id='t')
assert r=={'context':'verified hot memory'}
c.hooks['post_llm_call']('s','wrong turn',turn_id='other')
assert len(events)==1
c.hooks['post_llm_call']('s','serializer finding',turn_id='t',side_question_token='capability-token')
c.hooks['post_llm_call']('s','duplicate',turn_id='t')
assert len(events)==2 and events[1][0]=='complete'
assert events[1][1]['prompt']=='inspect serializer'
assert events[1][1]['summary']=='serializer finding'
assert events[1][1]['packId']=='pack'
assert events[1][1]['workspaceRoot']=='/actual-session-workspace'
c.hooks['pre_llm_call']('s','second goal',turn_id='t2')
c.hooks['on_session_end']('s',completed=False,interrupted=True)
assert len(events)==3
c.hooks['on_session_end']('s',turn_id='t2',completed=False,interrupted=True,error='secret-provider-detail')
c.hooks['on_session_end']('s',turn_id='t2',completed=False,interrupted=True)
assert len(events)==4 and events[3][0]=='failed'
assert events[3][1]['turnId']=='t2'
c.hooks['pre_llm_call']('s','recoverable goal',turn_id=0)
c.hooks['api_request_error']('s',turn_id=0,retryable=True,retry_count=1,max_retries=3,error='secret-provider-detail')
assert len(events)==5
c.hooks['api_request_error']('s',turn_id=0,retryable=False,error='secret-provider-detail')
c.hooks['api_request_error']('s',turn_id=0,retryable=False)
assert len(events)==6 and events[5][0]=='failed' and events[5][1]['turnId']=='0'
c.hooks['post_llm_call']('s','recovered successfully',turn_id=0)
assert len(events)==7 and events[6][0]=='complete'
c.hooks['pre_llm_call']('s','exhausted retries',turn_id='t4')
c.hooks['api_request_error']('s',turn_id='t4',retryable=True,retry_count=3,max_retries=3)
c.hooks['on_session_end']('s',turn_id='t4',completed=False,failed=True)
assert len(events)==9 and events[8][0]=='failed'
assert 'secret-provider-detail' not in json.dumps(events)
print('Hermes callback contract passed')
`;
    expect(execFileSync("python3", ["-c", program], { encoding: "utf8" })).toContain("passed");
  });
});
