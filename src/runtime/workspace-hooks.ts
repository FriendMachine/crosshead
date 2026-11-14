import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { assertManagedFilePath, shellQuote, writeManagedFile } from "./adapter-utils";
import { HOST_HOOK_EVENTS, PLUGIN_DISPATCH_CAPABILITY, renderHostHookGroups, type HookHost } from "./host-hook-spec";
import { homedir } from "node:os";
import { acquireWorkspaceSetupKernelLock } from "./daemon-kernel-lock";
import { workspaceDirectoryPath as directoryPath, workspaceRepositoryRoot as repositoryRoot, workspaceProjectRoot } from "./workspace-identity";
export { workspaceProjectRoot } from "./workspace-identity";
import { loadProfile, resolveRuntimePaths, type RuntimePaths } from "./runtime-persistence";
import { isLocalOnlyRuntimeProfile, localHotMemoryAdoptionFingerprint, planLocalHotMemoryAdoption } from "./local-hot-memory";
import { isRuntimeProfileName, resolveClaudeCodeHostHome, resolveCodexHostHome } from "./runtime-env";

export type HookScope = "project" | "all" | "manual";
export type WorkspaceHookBinding = {
  id: string;
  host: HookHost;
  root: string | null;
  hostHome: string;
  profile: string;
  sourceExcerpts: boolean;
  registration?: "project" | "user";
  legacyUnscoped?: boolean;
  legacyBefore?: string;
  legacyNpub?: string;
};

type HookPolicy = { version: 1; scope: HookScope; bindings: WorkspaceHookBinding[] };
type Settings = Record<string, unknown>;
type Edit = { file: string; root: string; before: string | null; after: string; executable?: boolean };
const hosts: HookHost[] = ["codex", "claude-code"];
const policyFile = (paths: RuntimePaths): string => path.join(paths.config, "workspace-hooks.json");
const object = (value: unknown): value is Settings => value !== null && typeof value === "object" && !Array.isArray(value);
const bindingId = /^[a-f0-9-]{36}$/;
const isBinding = (value: unknown): value is WorkspaceHookBinding =>
  object(value) && typeof value.id === "string" && bindingId.test(value.id) &&
  (value.host === "codex" || value.host === "claude-code") &&
  (value.root === null || (typeof value.root === "string" && path.isAbsolute(value.root))) &&
  typeof value.hostHome === "string" && path.isAbsolute(value.hostHome) &&
  typeof value.profile === "string" && isRuntimeProfileName(value.profile) && typeof value.sourceExcerpts === "boolean" &&
  (value.registration === undefined || value.registration === "project" || value.registration === "user") &&
  (value.legacyUnscoped === undefined || typeof value.legacyUnscoped === "boolean") &&
  (value.legacyBefore === undefined || (typeof value.legacyBefore === "string" && Number.isFinite(Date.parse(value.legacyBefore)))) &&
  (value.legacyNpub === undefined || typeof value.legacyNpub === "string");

const readText = (file: string): string | null => {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const readWorkspaceHookPolicy = (paths: RuntimePaths): HookPolicy | null => {
  const file = policyFile(paths);
  assertManagedFilePath(file, paths.home);
  const text = readText(file);
  if (text === null) return null;
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`Invalid Crosshead workspace hook settings in ${file}. Run crosshead workspace repair --home ${shellQuote(paths.home)} to preserve the damaged file and pause automatic hooks.`); }
  if (!object(data) || data.version !== 1 || !Array.isArray(data.bindings) || !data.bindings.every(isBinding) ||
      (data.scope !== "project" && data.scope !== "all" && data.scope !== "manual") ||
      (data.scope === "manual" && data.bindings.length > 0) ||
      data.bindings.some((binding) => (binding.root === null) !== (data.scope === "all"))) {
    throw new Error(`Invalid Crosshead workspace hook settings in ${file}. Run crosshead workspace repair --home ${shellQuote(paths.home)} to preserve the damaged file and pause automatic hooks.`);
  }
  return { version: 1, scope: data.scope, bindings: data.bindings };
};

const appliesIn = (binding: WorkspaceHookBinding, directory: string): boolean => {
  if (binding.root === null) return true;
  const relative = path.relative(binding.root, directory);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const repo = repositoryRoot(directory);
  return repo === null || repo === binding.root;
};

/** undefined uses legacy dispatch; null skips the invocation, including stale hooks. */
export const workspaceHookForInvocation = (
  policy: HookPolicy | null, host: HookHost, id: string | boolean | undefined, directory: string
): { binding: WorkspaceHookBinding; root: string } | null | undefined => {
  if (!policy) return id === undefined ? undefined : null;
  const binding = policy.bindings.find((entry) => entry.host === host && entry.id === id);
  if (!binding) return null;
  let resolved: string;
  try { resolved = directoryPath(directory); } catch { return null; }
  if (!appliesIn(binding, resolved)) return null;
  // Within plain directories, the closest explicit binding wins.
  if (binding.root && policy.bindings.some((other) =>
    other.host === host && other.root && other.root.length > binding.root!.length && appliesIn(other, resolved))) return null;
  return { binding, root: binding.root ?? repositoryRoot(resolved) ?? resolved };
};

const hookFile = (binding: WorkspaceHookBinding): string =>
  binding.root && binding.registration !== "user"
    ? path.join(binding.root, binding.host === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json")
    : path.join(binding.hostHome, binding.host === "codex" ? "hooks.json" : "settings.json");

const codexHookRegistration = (root: string): "project" | "user" => {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", ".codex/hooks.json"], { stdio: "ignore", timeout: 2000 });
    return "user";
  } catch { return "project"; }
};

const projectIgnoreFile = (root: string): { file: string; root: string } => {
  try {
    const exclude = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    const file = path.resolve(root, exclude);
    return { file, root: path.dirname(file) };
  } catch { return { file: path.join(root, ".gitignore"), root }; }
};
const localHookIgnore = "# Crosshead local hook settings\n/.codex/hooks.json\n";

const hostHome = (host: HookHost, options: { codexHome?: string; claudeHome?: string }): string =>
  host === "codex" ? resolveCodexHostHome(options.codexHome) : resolveClaudeCodeHostHome(options.claudeHome);

const hookPrefix = (paths: RuntimePaths, host: HookHost): string =>
  `${shellQuote(path.join(realHome(paths.home), "bin", "crosshead"))} host-hook ${host} `;

const invokesLegacyHook = (command: string, wrapper: string, runtimeHomes: string[], host: HookHost): boolean => {
  const executable = [shellQuote(wrapper), wrapper].find((token) => command.startsWith(`${token} `));
  if (!executable) return false;
  const args = command.slice(executable.length).trimStart();
  const homeFlag = host === "codex" ? "--codex-home" : "--claude-home";
  return HOST_HOOK_EVENTS.some(({ event }) => [event, shellQuote(event)].some((token) => {
    if (args === token) return true;
    return runtimeHomes.some((home) => [home, shellQuote(home)].some((value) => {
      const prefix = `${token} --home ${value}`;
      if (args === prefix) return true;
      const hostPrefix = `${prefix} ${homeFlag} `;
      if (!args.startsWith(hostPrefix)) return false;
      const argument = args.slice(hostPrefix.length);
      // The installers end the command with one absolute host-home argument.
      return /^'\/(?:[^']|'"'"')*'$/.test(argument) || /^\/[\w./-]*$/.test(argument);
    }));
  }));
};

const bindingCommands = (paths: RuntimePaths, binding: WorkspaceHookBinding, includeDisabled = false) =>
  renderHostHookGroups(binding.host, (event) =>
    `${hookPrefix(paths, binding.host)}${event} --home ${shellQuote(realHome(paths.home))} --binding ${binding.id} --source-excerpts ${binding.sourceExcerpts ? "on" : "off"}`)
    .filter(([event]) => includeDisabled || binding.sourceExcerpts || (event !== "PostToolUse" && event !== "PostToolUseFailure"));

const invokesScopedHook = (command: string, paths: RuntimePaths, host: HookHost): boolean => {
  // Accept only the exact generated shell form, with both paths resolving to
  // this runtime. This also recognizes earlier installs through a home symlink.
  const quoted = "'(?:[^']|'\"'\"')*'";
  const events = HOST_HOOK_EVENTS.map(({ event }) => event).join("|");
  const match = new RegExp(`^(${quoted}) host-hook ${host} (${events}) --home (${quoted}) --binding [a-f0-9-]{36}( --source-excerpts (on|off))?$`).exec(command);
  if (!match) return false;
  const unquote = (token: string) => token.slice(1, -1).replace(/'"'"'/g, "'");
  const executable = unquote(match[1]!), home = unquote(match[3]!);
  if (shellQuote(executable) !== match[1] || shellQuote(home) !== match[3] || !path.isAbsolute(home) || !path.isAbsolute(executable)) return false;
  try {
    return realpathSync(home) === realpathSync(paths.home) &&
      realpathSync(executable) === realpathSync(path.join(paths.bin, "crosshead"));
  } catch { return false; }
};

const settings = (file: string, text: string | null): Settings => {
  if (text === null) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) {
    throw new Error(`Expected a settings object with a hooks object in ${file}`);
  }
  return value;
};

const removeCommands = (data: Settings, remove: (command: string) => boolean): void => {
  if (!object(data.hooks)) return;
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) continue;
    data.hooks[event] = groups.flatMap((group: unknown) => {
      if (!object(group) || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((handler: unknown) => !object(handler) ||
	typeof handler.command !== "string" || !remove(handler.command));
      return hooks.length === group.hooks.length ? [group] : hooks.length ? [{ ...group, hooks }] : [];
    });
    if (Array.isArray(data.hooks[event]) && (data.hooks[event] as unknown[]).length === 0 && groups.length > 0) {
      delete data.hooks[event];
    }
  }
};

const workspaceHookStateBase = (paths: RuntimePaths, binding: WorkspaceHookBinding, root: string): string =>
  path.join(paths.state, "workspace-hooks", binding.id, createHash("sha256").update(root).digest("hex"));

const receiptFile = (paths: RuntimePaths, binding: WorkspaceHookBinding, root: string, source: "startup" | "resume"): string =>
  `${workspaceHookStateBase(paths, binding, root)}-${source}.json`;

export const recordWorkspaceHookStart = (
  paths: RuntimePaths, binding: WorkspaceHookBinding, root: string, source: string | null
): void => {
  if (source !== "startup" && source !== "resume") return;
  writeManagedFile(receiptFile(paths, binding, root, source), JSON.stringify({
    profile: binding.profile, workspaceRoot: root, observedAt: new Date().toISOString(),
  }), paths.home);
};

export const workspaceHookStateFile = (paths: RuntimePaths, binding: WorkspaceHookBinding, root: string): string =>
  `${workspaceHookStateBase(paths, binding, root)}.json`;

export const inspectWorkspaceHooks = (home?: string, directory?: string) => {
  const paths = resolveRuntimePaths(home);
  let policy: HookPolicy | null = null;
  let error: string | null = null;
  let workspaceError: string | null = null;
  let resolved: string | null = null;
  try { policy = readWorkspaceHookPolicy(paths); } catch (caught) { error = String((caught as Error).message); }
  try { resolved = directory ? directoryPath(directory) : null; }
  catch { workspaceError = `Workspace directory is unavailable: ${directory}`; }
  const bindings = (workspaceError ? [] : policy?.bindings ?? []).filter((binding) => !resolved ||
    workspaceHookForInvocation(policy, binding.host, binding.id, resolved) !== null);
  return {
    scope: error ? "invalid" as const : policy?.scope ?? "legacy",
    error, workspaceError, workspace: resolved,
    bindings: bindings.map((binding) => {
      const file = hookFile(binding);
      let configured = false;
      try {
	const hooks = settings(file, readText(file)).hooks;
	configured = object(hooks) && bindingCommands(paths, binding).every(([event, group]) => {
	  const groups = hooks[event];
	  return Array.isArray(groups) && groups.some((entry) => object(entry) && entry.matcher === group.matcher &&
	    Array.isArray(entry.hooks) && entry.hooks.some((handler) =>
	      object(handler) && handler.type === "command" && handler.command === group.hooks[0]!.command));
	});
      } catch { /* Invalid or removed settings are reported as missing. */ }
      const observation = (source: "startup" | "resume") => {
	const expectedRoot = binding.root ?? (resolved ? repositoryRoot(resolved) ?? resolved : null);
	if (!expectedRoot) return null;
	try {
	  const receipt = JSON.parse(readText(receiptFile(paths, binding, expectedRoot, source)) ?? "null") as Settings | null;
	  return receipt?.profile === binding.profile && receipt.workspaceRoot === expectedRoot
	    ? receipt : null;
	} catch { return null; }
      };
      return {
	...binding, file, configured,
	memoryMode: loadProfile(paths, binding.profile)?.memoryMode ?? null,
	startup: configured ? observation("startup") : null,
	resume: configured ? observation("resume") : null,
      };
    }),
  };
};

export type WorkspaceHookTarget = {
  directory: string;
  hosts: HookHost[];
  profile: string;
  sourceExcerpts?: boolean;
};

type PlanOptions = {
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  scope: HookScope;
  targets: WorkspaceHookTarget[];
  remove?: { directory: string; hosts: HookHost[] };
  removeHost?: HookHost;
  cleanup?: boolean;
  refresh?: boolean;
};

export const planWorkspaceHooks = (options: PlanOptions) => {
  const paths = resolveRuntimePaths(options.home);
  const previous = readWorkspaceHookPolicy(paths);
  const policy: HookPolicy = {
    version: 1, scope: options.scope,
    bindings: previous?.scope === options.scope ? [...previous.bindings] : [],
  };
  if (options.removeHost) policy.bindings = policy.bindings.filter((binding) => binding.host !== options.removeHost);
  if (options.remove) {
    const root = existsSync(options.remove.directory) ? workspaceProjectRoot(options.remove.directory) : path.resolve(options.remove.directory);
    policy.bindings = policy.bindings.filter((binding) =>
      binding.root !== root || !options.remove!.hosts.includes(binding.host));
  }
  const planned = new Set<string>();
  for (const target of options.targets) {
    if (!isRuntimeProfileName(target.profile)) throw new Error(`Invalid profile name: ${target.profile}`);
    const root = options.scope === "all" ? null : workspaceProjectRoot(target.directory);
    if (root && (root === path.parse(root).root || root === realHome(homedir()))) {
      throw new Error("Choose a project directory inside your home, or select all projects explicitly.");
    }
    for (const host of target.hosts) {
      const key = JSON.stringify([root, host]);
      if (planned.has(key)) throw new Error(`Choose one profile per host in ${root ?? "all projects"}.`);
      planned.add(key);
      const existing = policy.bindings.find((binding) => binding.root === root && binding.host === host);
      const resolvedHome = hostHome(host, options);
      const registration = host === "codex" && root ? codexHookRegistration(root) : "project";
      const selectedProfile = loadProfile(paths, target.profile);
      const inheritLegacy = existing?.profile === target.profile && existing.legacyNpub === selectedProfile?.npub;
      const legacyUnscoped = (inheritLegacy ? existing?.legacyUnscoped : undefined) ?? (!previous && root !== null && Boolean(selectedProfile) &&
	new Set(options.targets.filter((entry) => entry.profile === target.profile).map((entry) => workspaceProjectRoot(entry.directory))).size === 1);
      const sourceExcerpts = target.sourceExcerpts ?? existing?.sourceExcerpts ?? false;
      if (existing?.profile === target.profile && existing.sourceExcerpts === sourceExcerpts &&
	  existing.hostHome === resolvedHome && (existing.registration ?? "project") === registration) continue;
      policy.bindings = policy.bindings.filter((binding) => binding !== existing);
      policy.bindings.push({ id: randomUUID(), root, host, hostHome: resolvedHome, profile: target.profile, sourceExcerpts, registration, legacyUnscoped,
	...(legacyUnscoped ? { legacyBefore: inheritLegacy ? existing?.legacyBefore ?? new Date().toISOString() : new Date().toISOString(), legacyNpub: selectedProfile!.npub } : {}) });
    }
  }

  const edits = new Map<string, Edit>();
  const guards: Array<{ file: string; root: string; before: string }> = [];
  const sourceSnapshots: Array<ReturnType<typeof planLocalHotMemoryAdoption>["snapshot"]> = [];
  const settingsFiles = new Map<string, { root: string; host: HookHost }>();
  for (const binding of [...(previous?.bindings ?? []), ...policy.bindings]) {
    settingsFiles.set(hookFile(binding), { root: binding.root && binding.registration !== "user" ? binding.root : binding.hostHome, host: binding.host });
    if (binding.root && binding.host === "claude-code") {
      settingsFiles.set(path.join(binding.root, ".claude/settings.json"), { root: binding.root, host: binding.host });
    }
  }
  // Retire settings-mode hooks that refer to this runtime. Other hooks and
  // settings stay in place. A plugin invocation is gated by the same policy.
  for (const host of options.cleanup || options.refresh ? [] : hosts) {
    const root = hostHome(host, options);
    settingsFiles.set(path.join(root, host === "codex" ? "hooks.json" : "settings.json"), { root, host });
  }
  const retired: string[] = [];
  const physicalHome = realHome(paths.home);
  const runtimeHomes = [paths.home, physicalHome];
  for (const [file, { root, host }] of settingsFiles) {
    const next = policy.bindings.filter((binding) => hookFile(binding) === file);
    assertManagedFilePath(file, root);
    const before = readText(file);
    if (before === null && next.length === 0) continue;
    const data = settings(file, before);
    const original = JSON.stringify(data);
    const owned = new Set([...(previous?.bindings ?? []), ...next]
      .filter((binding) => hookFile(binding) === file)
      .flatMap((binding) => bindingCommands(paths, binding, true).flatMap(([, group]) => {
	const command = group.hooks[0]!.command;
	return [command, command.replace(/ --source-excerpts (on|off)$/, "")];
      })));
    removeCommands(data, (command) => {
      if (owned.has(command) || invokesScopedHook(command, paths, host)) return true;
      const legacy = ["crosshead", "onlybots"].some((name) => runtimeHomes.some((home) =>
	invokesLegacyHook(command, path.join(home, "bin", `${name}-${host}-hook`), runtimeHomes, host)));
      if (legacy && !retired.includes(file)) retired.push(file);
      return legacy;
    });
    for (const binding of next) {
      const hooks = (data.hooks ??= {}) as Settings;
      for (const [event, group] of bindingCommands(paths, binding)) {
	const groups = (hooks[event] ??= []);
	if (!Array.isArray(groups)) throw new Error(`Invalid ${event} hook groups in ${file}`);
	groups.push(group);
      }
    }
    if (JSON.stringify(data) !== original) edits.set(file, { file, root, before, after: `${JSON.stringify(data, null, 2)}\n` });
  }

  const projectBindings = [...(previous?.bindings ?? []), ...policy.bindings]
    .filter((binding) => binding.host === "codex" && binding.root && binding.registration !== "user");
  const ignoreFiles = new Map<string, { root: string; active: boolean }>();
  for (const root of new Set(projectBindings.map((binding) => binding.root!))) {
    const ignore = projectIgnoreFile(root);
    const active = policy.bindings.some((binding) => binding.host === "codex" && binding.root === root && binding.registration !== "user");
    ignoreFiles.set(ignore.file, { root: ignore.root, active: active || Boolean(ignoreFiles.get(ignore.file)?.active) });
  }
  for (const [file, { root, active }] of ignoreFiles) {
    const before = readText(file);
    let after = before ?? "";
    if (active && !after.split("\n").includes("/.codex/hooks.json")) after += (after && !after.endsWith("\n") ? "\n" : "") + localHookIgnore;
    if (!active) after = after.replace(localHookIgnore, "");
    if (after !== (before ?? "")) edits.set(file, { file, root, before, after });
  }

  // Plugin launchers use these stable paths even for a manual/project setup.
  // Keep them dispatching through the current CLI across release updates.
  for (const host of options.cleanup ? [] : hosts) {
    for (const name of ["crosshead", "onlybots"]) {
      const file = path.join(paths.bin, `${name}-${host}-hook`);
      assertManagedFilePath(file, paths.home);
      const before = readText(file);
      const after = `#!/bin/sh\n# ${PLUGIN_DISPATCH_CAPABILITY}\nexec ${shellQuote(path.join(paths.bin, "crosshead"))} host-hook ${host} "$@"\n`;
      if (before !== after) edits.set(file, { file, root: paths.home, before, after, executable: true });
    }
  }
  // Adopt eligible history once, before SessionStart can replace the runtime alias.
  // The migration is part of the same preview and guarded settings plan.
  const adopted = new Set<string>();
  for (const binding of policy.bindings) {
    const profile = loadProfile(paths, binding.profile);
    if (!binding.root || !profile || !isLocalOnlyRuntimeProfile(profile) || previous?.bindings.some(entry => entry.id === binding.id)) continue;
    const key = JSON.stringify([binding.profile, binding.root]);
    if (adopted.has(key)) continue;
    adopted.add(key);
    const adoption = planLocalHotMemoryAdoption(paths.state, profile, `repo:${binding.root}`, binding.legacyUnscoped === true, binding.legacyBefore);
    for (const item of adoption.files) {
      if (!edits.has(item.file)) edits.set(item.file, { file: item.file, root: paths.home, before: null, after: item.content });
    }
    guards.push(...adoption.sources.map(source => ({ ...source, root: paths.home })));
    sourceSnapshots.push(adoption.snapshot);
  }
  const file = policyFile(paths);
  const before = readText(file);
  const after = `${JSON.stringify(policy, null, 2)}\n`;
  if (before !== after) edits.set(file, { file, root: paths.home, before, after });
  for (const edit of edits.values()) assertManagedFilePath(edit.file, edit.root);
  return { paths, policy, edits: [...edits.values()], guards, sourceSnapshots, retired };
};

const realHome = (home: string): string => {
  try { return realpathSync(home); } catch { return home; }
};

export type WorkspaceHookPlan = ReturnType<typeof planWorkspaceHooks>;

export const summarizeWorkspaceHookPlan = (plan: WorkspaceHookPlan) => ({
  scope: plan.policy.scope,
  bindings: plan.policy.bindings,
  files: plan.edits.map((edit) => edit.file),
  replacesUserHooksIn: plan.retired,
});

export const assertWorkspacePlanCurrent = (plan: WorkspaceHookPlan): void => {
  for (const edit of [...plan.edits, ...plan.guards]) {
    assertManagedFilePath(edit.file, edit.root);
    if (readText(edit.file) !== edit.before) throw new Error(`Settings changed since preview: ${edit.file}. Run setup again.`);
  }
  for (const snapshot of plan.sourceSnapshots) {
    if (localHotMemoryAdoptionFingerprint(snapshot.stateDir, snapshot.owner) !== snapshot.fingerprint) {
      throw new Error("Local memory changed since preview. Run setup again.");
    }
  }
};

export const withWorkspaceSetupLock = async <T>(paths: RuntimePaths, operation: () => Promise<T>): Promise<T> => {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  const lock = await acquireWorkspaceSetupKernelLock(realpathSync(paths.home));
  try { return await operation(); }
  finally { await lock.close(); }
};

export const applyWorkspaceHookPlan = (plan: WorkspaceHookPlan): void => {
  for (const binding of plan.policy.bindings) {
    if (!loadProfile(plan.paths, binding.profile)) throw new Error(`Unknown profile: ${binding.profile}`);
  }
  assertWorkspacePlanCurrent(plan);
  const written: Edit[] = [];
  try {
    for (const edit of plan.edits) {
      writeManagedFile(edit.file, edit.after, edit.root);
      written.push(edit);
      if (edit.executable) chmodSync(edit.file, 0o755);
    }
  } catch (error) {
    for (const edit of written.reverse()) {
      if (edit.before === null) rmSync(edit.file, { force: true });
      else {
	writeManagedFile(edit.file, edit.before, edit.root);
	if (edit.executable) chmodSync(edit.file, 0o755);
      }
    }
    throw error;
  }
};

export type WorkspaceHookInspection = ReturnType<typeof inspectWorkspaceHooks>;
export const workspaceBindingStatus = (
  binding: WorkspaceHookInspection["bindings"][number], workspace: string | null
): string => {
  if (!binding.configured) return "hook settings missing or changed";
  if (!binding.memoryMode) return "profile missing";
  if (binding.memoryMode === "off") return "memory off";
  if (binding.startup || binding.resume) return "observed in host";
  return !workspace && !binding.root ? "configured; check from a project" : "configured; waiting for host";
};

/** Malformed local configuration disables hook work without failing host tools. */
export const readWorkspacePolicyForHook = (
  paths: RuntimePaths, event: string, binding: string | boolean | undefined
): HookPolicy | null | false => {
  try { return readWorkspaceHookPolicy(paths); }
  catch {
    if (binding && ["sessionstart", "session_start", "userpromptsubmit", "user_prompt_submit"].includes(event)) {
      console.error("Crosshead workspace settings are invalid. Automatic memory is paused; run crosshead workspace check.");
    }
    return false;
  }
};

export const refreshWorkspaceHooks = async (home: string): Promise<void> => {
  const paths = resolveRuntimePaths(home);
  await withWorkspaceSetupLock(paths, async () => {
    const policy = readWorkspaceHookPolicy(paths);
    if (!policy) return;
    applyWorkspaceHookPlan(planWorkspaceHooks({ home, scope: policy.scope, targets: [], refresh: true }));
  });
};

/** Recovery keeps the exact damaged bytes and leaves all automatic hooks paused. */
export const repairWorkspaceHookPolicy = async (home?: string, dryRun = false) => {
  const paths = resolveRuntimePaths(home);
  const repair = () => {
    const file = policyFile(paths);
    assertManagedFilePath(file, paths.home);
    try {
      const policy = readWorkspaceHookPolicy(paths);
      return { applied: false, backup: null as string | null, scope: policy?.scope ?? "legacy", message: "Workspace settings do not need repair." };
    } catch {
      const original = readFileSync(file);
      const backup = `${file}.invalid-${randomUUID()}.json`;
      if (!dryRun) {
	writeManagedFile(backup, original, paths.home);
	writeManagedFile(file, JSON.stringify({ version: 1, scope: "manual", bindings: [] }, null, 2) + "\n", paths.home);
      }
      return { applied: !dryRun, backup, scope: "manual", message: "Automatic hooks are paused. Run crosshead quickstart --scope project to review and configure selected projects again." };
    }
  };
  return dryRun ? repair() : withWorkspaceSetupLock(paths, async () => repair());
};
