import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, shellQuote } from "../adapter-utils";
import type { HookHost } from "../host-hook-spec";
import { loadAdapterRecord, loadProfile, loadRuntimeConfig, resolveRuntimePaths } from "../runtime-persistence";
import {
  applyWorkspaceHookPlan, assertWorkspacePlanCurrent, inspectWorkspaceHooks, planWorkspaceHooks, readWorkspaceHookPolicy, summarizeWorkspaceHookPlan,
  withWorkspaceSetupLock, workspaceBindingStatus, workspaceProjectRoot, type HookScope, type WorkspaceHookTarget,
} from "../workspace-hooks";
import { isRuntimeProfileName } from "../runtime-env";
import { uninstallCodexFromCli } from "../codex-adapter";
import { uninstallClaudeCodeFromCli } from "../claude-code-adapter";
import { installCoreFromCli, keygenFromCli } from "./core";
import { ensureQuickstartDaemon, type QuickstartCliPaths } from "./quickstart";

type Flags = Record<string, string | boolean>;
const str = (flags: Flags, key: string): string | undefined => typeof flags[key] === "string" ? flags[key] : undefined;
const enabled = (flags: Flags, key: string): boolean => flags[key] === true || flags[key] === "true";
const selectedHosts = (value: string): HookHost[] => {
  if (value === "both") return ["codex", "claude-code"];
  if (value === "codex" || value === "claude-code") return [value];
  throw new Error("Choose --adapter codex, claude-code, or both");
};
const scopeValue = (value: string): HookScope => {
  if (value === "project" || value === "all" || value === "manual") return value;
  throw new Error("Choose --scope project, all, or manual");
};
const sourceExcerpts = (flags: Flags): boolean | undefined => {
  const value = flags["source-excerpts"];
  if (value === undefined) return undefined;
  if (value === "off") return false;
  if (value === true || value === "on") return true;
  throw new Error("Choose --source-excerpts on or off");
};
const planOptions = (flags: Flags) => ({
  home: str(flags, "home"), codexHome: str(flags, "codex-home"), claudeHome: str(flags, "claude-home"),
});
const homeArgs = (home?: string): string[] => home ? ["--home", home] : [];

const describePlan = (plan: ReturnType<typeof summarizeWorkspaceHookPlan>): string => [
  `Crosshead scope: ${plan.scope === "project" ? "selected projects" : plan.scope === "all" ? "all projects" : "manual commands only"}`,
  ...plan.bindings.map((binding) => `  ${binding.root ?? "Every directory"} · ${binding.host} · profile ${binding.profile} · source excerpts ${binding.sourceExcerpts ? "on" : "off"}`),
  ...plan.bindings.filter(binding => binding.legacyUnscoped).map(binding =>
    `  Retain earlier unscoped checkpoints for profile ${binding.profile} in ${binding.root ?? "the selected workspace"}`),
  ...(plan.replacesUserHooksIn.length ? ["Replaces earlier Crosshead hooks in", ...plan.replacesUserHooksIn.map((file) => `  ${file}`)] : []),
  ...(plan.files.length ? ["Files to update", ...plan.files.map((file) => `  ${file}`)] : ["Hook settings already match"]),
].join("\n");

export const formatWorkspaceHookInspection = (inspection: ReturnType<typeof inspectWorkspaceHooks>): string => {
  if (inspection.scope === "legacy") return "Crosshead uses the existing host setup. Run crosshead quickstart to choose a scope.";
  if (inspection.bindings.length === 0) return "No automatic Crosshead hooks apply here.";
  return inspection.bindings.map((binding) => {
    const status = workspaceBindingStatus(binding, inspection.workspace);
    return [
      `${binding.host} · ${binding.root ?? "all projects"} · profile ${binding.profile} · ${status}`,
      `  ${binding.file}`,
      ...(binding.startup ? [`  Startup observed ${binding.startup.observedAt}`] : []),
      ...(binding.resume ? [`  Resume observed ${binding.resume.observedAt}`] : []),
      ...(binding.configured && binding.memoryMode && binding.memoryMode !== "off" && !binding.startup && !binding.resume
	? [binding.host === "codex"
	  ? "  Open the project in Codex, review its hooks in /hooks, then open a fresh session."
	  : "  Open a fresh Claude Code session in this project."] : []),
    ].join("\n");
  }).join("\n");
};

export const workspaceHooksFromCli = async (argv: string[]): Promise<string> => {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  const options = planOptions(flags);
  const directory = str(flags, "workspace-root") ?? process.cwd();
  if (command === "list" || command === "check") {
    const inspection = inspectWorkspaceHooks(options.home, command === "check" ? directory : undefined);
    return flags.json ? JSON.stringify(inspection, null, 2) : formatWorkspaceHookInspection(inspection);
  }
  if (command !== "add" && command !== "remove") throw new Error("Choose workspace add, remove, list, check, or link");
  const hosts = selectedHosts(str(flags, "adapter") ?? (command === "remove" ? "both" : ""));
  const paths = resolveRuntimePaths(options.home);
  const profile = str(flags, "profile") ?? loadRuntimeConfig(paths).defaultProfile;
  if (command === "add" && (!profile || !isRuntimeProfileName(profile) || !loadProfile(paths, profile))) {
    throw new Error("Choose an existing --profile, or run crosshead quickstart to create one.");
  }
  const current = inspectWorkspaceHooks(options.home);
  if (command === "add" && current.scope === "all") {
    throw new Error("All-project hooks are active. Use crosshead quickstart --scope project to preview changing scope.");
  }
  if (command === "remove" && current.scope !== "project") {
    throw new Error("Project removal requires project scope. Run crosshead quickstart --scope manual to turn off automatic hooks.");
  }
  const plan = planWorkspaceHooks({
    ...options, scope: "project",
    targets: command === "add" ? [{ directory, hosts, profile: profile!, sourceExcerpts: sourceExcerpts(flags) }] : [],
    ...(command === "remove" ? { remove: { directory, hosts } } : {}),
  });
  const preview = summarizeWorkspaceHookPlan(plan);
  if (enabled(flags, "dry-run")) return flags.json ? JSON.stringify({ applied: false, ...preview }, null, 2) : describePlan(preview);
  if (!existsSync(path.join(paths.bin, "crosshead"))) throw new Error("Install the Crosshead CLI first with crosshead install.");
  await withWorkspaceSetupLock(paths, async () => applyWorkspaceHookPlan(plan));
  const inspection = inspectWorkspaceHooks(options.home, existsSync(directory) ? directory : undefined);
  return flags.json ? JSON.stringify({ applied: true, ...inspection }, null, 2) : formatWorkspaceHookInspection(inspection);
};

export const uninstallWorkspaceHostFromCli = async (host: HookHost, argv: string[]): Promise<string | null> => {
  const options = planOptions(parseArgs(argv).flags);
  const paths = resolveRuntimePaths(options.home);
  if (!readWorkspaceHookPolicy(paths)) return null;
  await withWorkspaceSetupLock(paths, async () => {
    const policy = readWorkspaceHookPolicy(paths);
    if (!policy) throw new Error("Workspace scope changed during uninstall. Run the command again.");
    const homes = new Set(policy.bindings.filter(binding => binding.host === host).map(binding => binding.hostHome));
    const recordedHome = loadAdapterRecord(paths, host)?.hostHome;
    if (recordedHome) homes.add(recordedHome);
    const explicitHome = host === "codex" ? options.codexHome : options.claudeHome;
    if (explicitHome) homes.add(explicitHome);
    const plan = planWorkspaceHooks({
      ...options,
      scope: policy.bindings.every((binding) => binding.host === host) ? "manual" : policy.scope,
      targets: [], removeHost: host, cleanup: true,
    });
    applyWorkspaceHookPlan(plan);
    const uninstall = host === "codex" ? uninstallCodexFromCli : uninstallClaudeCodeFromCli;
    const homeFlag = host === "codex" ? "--codex-home" : "--claude-home";
    if (homes.size === 0) await uninstall(argv);
    else for (const home of homes) await uninstall([...argv, homeFlag, home]);
  });
  return `Uninstalled Crosshead for ${host}.`;
};

const guidedSetup = async (flags: Flags, fallbackProfile: string, profiles: string[]) => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (question: string, fallback: string): Promise<string> =>
    (await terminal.question(`${question} [${fallback}] `)).trim() || fallback;
  try {
    process.stderr.write("Where should Crosshead run for Codex and Claude Code?\n  1  This project (recommended)\n  2  All projects\n  3  Manual commands only\n");
    const choice = await ask("Choose 1, 2, or 3", "1");
    if (!["1", "2", "3"].includes(choice)) throw new Error("Choose 1, 2, or 3");
    const scope: HookScope = choice === "1" ? "project" : choice === "2" ? "all" : "manual";
    if (profiles.length) process.stderr.write(`Existing profiles: ${profiles.join(", ")}\n`);
    const targets: WorkspaceHookTarget[] = [];
    do {
      const directory = scope === "project" ? await ask("Project directory", str(flags, "workspace-root") ?? process.cwd()) : process.cwd();
      const hosts = scope === "manual" ? [] : selectedHosts(await ask("Host (codex, claude-code, or both)", "codex"));
      const profile = await ask("Profile name (choose an existing name or enter a new one)", fallbackProfile);
      let capture = false;
      if (hosts.length) {
	process.stderr.write("Checkpoints can include your prompt and a summary. Source excerpts also preserve exact text from workspace reads. Synced excerpts can reach the service and later model prompts.\n");
	capture = /^y(es)?$/i.test(await ask("Include source excerpts?", "no"));
      }
      targets.push({ directory, hosts, profile, sourceExcerpts: capture });
    } while (scope === "project" && /^y(es)?$/i.test(await ask("Add another project?", "no")));
    return { scope, targets, confirm: async (preview: string) => {
      process.stderr.write(`\n${preview}\n`);
      return /^y(es)?$/i.test(await ask("Apply this setup?", "no"));
    }, close: () => terminal.close() };
  } catch (error) {
    terminal.close();
    throw error;
  }
};

export const scopedQuickstartFromCli = async (flags: Flags, scripts: QuickstartCliPaths, guided: boolean): Promise<string> => {
  if (flags.scope === true) throw new Error("Choose --scope project, all, or manual");
  if (flags["hook-mode"] !== undefined) throw new Error("Choose a workspace --scope or legacy --hook-mode");
  const options = planOptions(flags);
  const paths = resolveRuntimePaths(options.home);
  const fallbackProfile = str(flags, "profile") ?? loadRuntimeConfig(paths).defaultProfile ?? "default";
  const knownProfiles = existsSync(paths.profiles)
    ? readdirSync(paths.profiles).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5))
    : [];
  const flow = guided ? await guidedSetup(flags, fallbackProfile, knownProfiles) : null;
  try {
    const scope = flow?.scope ?? scopeValue(str(flags, "scope") ?? "project");
    const targets = flow?.targets ?? [{
      directory: str(flags, "workspace-root") ?? process.cwd(),
      hosts: scope === "manual" ? [] : selectedHosts(str(flags, "adapter") ?? str(flags, "host") ?? "codex"),
      profile: fallbackProfile, sourceExcerpts: sourceExcerpts(flags),
    }];
    const names = [...new Set(targets.map((target) => target.profile))];
    if (names.some((name) => !isRuntimeProfileName(name))) throw new Error("Profile names must use 1–128 letters, numbers, dots, underscores, plus signs or hyphens.");
    const profileSnapshot = (name: string) => {
      const profile = loadProfile(paths, name);
      return profile ? JSON.stringify([profile.npub, profile.apiBase, profile.memoryMode, profile.workspaceScope]) : null;
    };
    const profilesBefore = new Map(names.map((name) => [name, profileSnapshot(name)]));
    const newProfiles = names.filter((name) => profilesBefore.get(name) === null);
    const apiBase = str(flags, "api-base") ?? str(flags, "apiBase") ?? (guided ? "https://crosshead.sh" : undefined);
    if (newProfiles.length > 0 && !apiBase) throw new Error("Supply --api-base <url> to create a new profile.");
    const explicitMode = str(flags, "memory-mode");
    const mode = explicitMode ?? (scope === "manual" ? "manual" : "assist");
    if (!["off", "manual", "assist", "auto"].includes(mode)) throw new Error("Choose --memory-mode off, manual, assist, or auto");
    for (const name of names) {
      const profile = loadProfile(paths, name);
      if (profile && explicitMode && profile.memoryMode !== explicitMode) {
	throw new Error(`Profile ${name} uses ${profile.memoryMode}. To change it, run crosshead memory mode ${explicitMode} --profile ${shellQuote(name)}.`);
      }
    }
    if (flags["create-checkout"]) throw new Error("Run crosshead billing checkout separately after project setup.");
    const plan = planWorkspaceHooks({ ...options, scope, targets: scope === "manual" ? [] : targets });
    const executable = path.join(paths.bin, "crosshead");
    const installRuntime = !existsSync(executable) ||
      !readFileSync(executable, "utf8").includes(shellQuote(scripts.cliScriptPath)) ||
      !existsSync(path.join(paths.bin, "crossheadd"));
    const preview = { ...summarizeWorkspaceHookPlan(plan), installRuntime, runtimeHome: paths.home, newProfiles, apiBase: newProfiles.length > 0 ? apiBase : null };
    const runtimePlan = installRuntime ? `Set up runtime files under ${paths.home}.\n` : "";
    const profilePlan = newProfiles.length > 0
      ? `Create ${newProfiles.join(", ")} at ${apiBase}; private keys stay on this machine.\n` : "";
    if (enabled(flags, "dry-run")) {
      return flags.json ? JSON.stringify({ applied: false, ...preview }, null, 2) : runtimePlan + profilePlan + describePlan(preview);
    }
    if (flow && !await flow.confirm(runtimePlan + profilePlan + describePlan(preview))) return "Setup cancelled.";
    const daemon = await withWorkspaceSetupLock(paths, async () => {
      assertWorkspacePlanCurrent(plan);
      if (names.some((name) => profileSnapshot(name) !== profilesBefore.get(name))) {
	throw new Error("A selected profile changed since preview. Run setup again to review it.");
      }
      const args = homeArgs(options.home);
      if (installRuntime) {
	const channel = str(flags, "channel") ?? loadRuntimeConfig(paths).channel;
	await installCoreFromCli([...args, "--channel", channel], scripts.cliScriptPath, scripts.daemonScriptPath);
      }
      for (const name of newProfiles) {
	await keygenFromCli([...args, "--setup", "--profile", name, "--api-base", apiBase!, "--memory-mode", mode,
	  "--workspace-scope", "repo", "--no-default", "--create-only", "--json"]);
      }
      const result = enabled(flags, "no-start") ? null : await ensureQuickstartDaemon({
	home: options.home, daemonScriptPath: scripts.daemonScriptPath, port: str(flags, "port"),
      });
      applyWorkspaceHookPlan(plan);
      return result;
    });
    const inspection = inspectWorkspaceHooks(options.home);
    const checks = scope === "project" ? [...new Set(targets.map((target) => workspaceProjectRoot(target.directory)))] : [process.cwd()];
    return flags.json
      ? JSON.stringify({ command: "quickstart", applied: true, home: paths.home, profiles: names, daemon, ...inspection }, null, 2)
      : [
	  "Crosshead setup complete.",
	  ...(daemon ? [daemon.detail] : []),
	  formatWorkspaceHookInspection(inspection),
	  ...checks.map((root) => `Verify from a fresh session with crosshead workspace check --workspace-root ${shellQuote(root)}${options.home ? ` --home ${shellQuote(paths.home)}` : ""}`),
	].join("\n");
  } finally { flow?.close(); }
};
