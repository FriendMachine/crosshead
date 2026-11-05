import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { assertManagedFilePath, createWorkspaceManifest, nowIso, parseArgs, writeManagedFile } from "./adapter-utils";
import { HostRuntimeAdapterBase } from "./host-adapter-base";
import { LocalRuntimeClient } from "./local-client";
import { ensureRuntimeHomeLayout, ONLYBOTS_RUNTIME_CORE_VERSION, removeRuntimeAdapterRecord, resolveRuntimeHome, upsertRuntimeAdapterRecord } from "./local-runtime";
import { renderHermesPlugin } from "./hermes-plugin";
import { adapterFile, adapterSnapshotFile } from "./runtime-persistence";

export type NativeHost = "hermes" | "opencode";
export const NATIVE_HOST_ADAPTER_VERSION = "0.1.0";
const MARKER = "crosshead-native-host-v1";
const ownerMarker = (config: NativeHostConfig): string => `${MARKER} owner=${createHash("sha256").update(JSON.stringify([config.name, config.runtimeHome])).digest("hex")}`;
export type NativeHostConfig = {
  marker: typeof MARKER;
  name: NativeHost;
  runtimeHome: string;
  hostHome: string;
  profileName: string;
  adapterVersion: string;
  hostBinary: string;
  nodeExecutable: string;
};
export type NativeHostInstallOptions = {
  home?: string; hostHome?: string; profileName?: string; adapterVersion?: string; hostBinary?: string;
};
const configFile = (home: string, name: NativeHost): string => path.join(home, "config", "native-hosts", `${name}.json`);
export const resolveNativeHostHome = (name: NativeHost, explicit?: string): string => path.resolve(explicit ?? (name === "hermes"
  ? process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes")
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")));

export const loadNativeHostConfig = (name: NativeHost, home?: string): NativeHostConfig => {
  const runtimeHome = resolveRuntimeHome(home);
  const config = JSON.parse(readFileSync(configFile(runtimeHome, name), "utf8")) as NativeHostConfig;
  if (config.marker !== MARKER || config.name !== name || config.runtimeHome !== runtimeHome) throw new Error(`Invalid managed ${name} configuration`);
  return config;
};

export const nativeHostFiles = (config: NativeHostConfig): string[] => config.name === "hermes"
  ? [path.join(config.hostHome, "plugins", "crosshead", "__init__.py"), path.join(config.hostHome, "plugins", "crosshead", "plugin.yaml")]
  : [path.join(config.hostHome, "plugins", "crosshead.js")];

export const installNativeHostAdapter = async (name: NativeHost, options: NativeHostInstallOptions = {}) => {
  const paths = ensureRuntimeHomeLayout(options.home);
  if (existsSync(configFile(paths.home, name))) {
    const previous = loadNativeHostConfig(name, paths.home);
    if (previous.hostHome !== resolveNativeHostHome(name, options.hostHome)) throw new Error(`Uninstall ${name} before changing its host home`);
  }
  const config: NativeHostConfig = { marker: MARKER, name, runtimeHome: paths.home,
    hostHome: resolveNativeHostHome(name, options.hostHome), profileName: options.profileName ?? "default",
    adapterVersion: options.adapterVersion ?? NATIVE_HOST_ADAPTER_VERSION, hostBinary: options.hostBinary ?? name, nodeExecutable: process.execPath };
  const files = nativeHostFiles(config);
  const owner = ownerMarker(config);
  const source = name === "hermes" ? `# ${owner}\n` + renderHermesPlugin(config, process.execPath, path.join(__dirname, "native-host-hook.js"))
    : `// ${owner}\nimport { createRequire } from 'node:module';\nconst { createOpenCodePlugin } = createRequire(import.meta.url)(${JSON.stringify(path.join(__dirname, "opencode-plugin.js"))});\nexport const CrossheadPlugin = (input) => createOpenCodePlugin(input, ${JSON.stringify(config)});\n`;
  // Preflight every path before writing; never overwrite a user's unrelated plugin.
  for (const file of [...files, configFile(paths.home, name)]) {
    assertManagedFilePath(file, file.startsWith(paths.home + path.sep) ? paths.home : config.hostHome);
    if (existsSync(file)) {
      const content = readFileSync(file, "utf8");
      if (files.includes(file) ? !content.split("\n")[0]!.endsWith(` ${owner}`) : !content.includes(MARKER)) throw new Error(`Refusing to overwrite unmanaged file or another runtime's plugin: ${file}`);
    }
  }
  const managed = [...files, configFile(paths.home, name)];
  const transactionFiles = [...managed, adapterFile(paths, name), adapterSnapshotFile(paths, name, config.adapterVersion)];
  for (const file of transactionFiles) assertManagedFilePath(file, files.includes(file) ? config.hostHome : paths.home);
  const backups = transactionFiles.map(file => existsSync(file) ? readFileSync(file, "utf8") : null);
  try {
    writeManagedFile(files[0]!, source, config.hostHome);
    writeManagedFile(configFile(paths.home, name), JSON.stringify(config, null, 2) + "\n", paths.home);
    const adapter = upsertRuntimeAdapterRecord(paths.home, { name, version: config.adapterVersion,
      runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION, status: "installed", profileName: config.profileName,
      hostHome: config.hostHome, managedFiles: managed, lastError: null, installedAt: nowIso(), updatedAt: nowIso() });
    if (name === "hermes") {
      writeManagedFile(files[1]!, `# ${owner}\nname: crosshead\nversion: ${JSON.stringify(config.adapterVersion)}\ndescription: Crosshead persistent memory\nprovides_hooks:\n  - pre_llm_call\n  - post_llm_call\n  - on_session_end\n  - api_request_error\n`, config.hostHome);
      // Let Hermes preserve its YAML and manage its own plugin activation.
      execFileSync(config.hostBinary, ["plugins", "enable", "crosshead"], { env: { ...process.env, HERMES_HOME: config.hostHome }, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    }
    return { adapter, config, managedFiles: adapter.managedFiles };
  } catch (error) {
    transactionFiles.forEach((file, index) => {
      if (backups[index] === null) rmSync(file, { force: true });
      else if (!existsSync(file) || readFileSync(file, "utf8") !== backups[index]) writeManagedFile(file, backups[index]!, files.includes(file) ? config.hostHome : paths.home);
    });
    throw error;
  }
};

export const uninstallNativeHostAdapter = async (name: NativeHost, home?: string): Promise<string[]> => {
  let config: NativeHostConfig;
  try { config = loadNativeHostConfig(name, home); } catch (error) {
    if (!existsSync(configFile(resolveRuntimeHome(home), name))) return [];
    throw error;
  }
  const files = [...nativeHostFiles(config), configFile(config.runtimeHome, name)];
  for (const file of files) {
    assertManagedFilePath(file, file === configFile(config.runtimeHome, name) ? config.runtimeHome : config.hostHome);
    if (existsSync(file)) {
      const content = readFileSync(file, "utf8");
      if (file === configFile(config.runtimeHome, name) ? !content.includes(MARKER) : !content.split("\n")[0]!.endsWith(` ${ownerMarker(config)}`)) throw new Error(`Refusing to remove modified unmanaged file or another runtime's plugin: ${file}`);
    }
  }
  if (name === "hermes") {
    try { execFileSync(config.hostBinary, ["plugins", "disable", "crosshead"], { env: { ...process.env, HERMES_HOME: config.hostHome }, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { /* Removing the plugin still disables it if Hermes itself was removed. */ }
  }
  const removed = files.filter(existsSync);
  for (const file of removed) rmSync(file);
  removeRuntimeAdapterRecord(config.runtimeHome, name);
  return removed;
};

export const nativeHostFromCli = async (name: NativeHost, args: string[], uninstall = false): Promise<string> => {
  const { flags } = parseArgs(args);
  const flag = (key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;
  if (uninstall) return `Removed ${name} plugin files: ${(await uninstallNativeHostAdapter(name, flag("home"))).length}`;
  const result = await installNativeHostAdapter(name, { home: flag("home"), hostHome: flag(`${name}-home`), hostBinary: flag(`${name}-bin`), profileName: flag("profile"), adapterVersion: flag("version") });
  return `Installed ${name} ${result.adapter.version} for profile ${result.config.profileName}. Restart ${name} to load the plugin.`;
};

export class NativeHostRuntimeAdapter extends HostRuntimeAdapterBase {
  protected readonly identity;
  constructor(protected readonly config: NativeHostConfig, protected readonly client = new LocalRuntimeClient({ home: config.runtimeHome, timeoutMs: 5_000 })) {
    super();
    this.identity = { runtimeId: config.name, wrapperVersionFallback: `${config.name}-plugin`, requestLabel: config.name === "hermes" ? "Hermes" : "OpenCode" };
  }
  protected async attachWorkspace(input: { profileName?: string; workspaceRoot: string; workspaceId: string; hostVersion?: string }): Promise<void> {
    await this.client.attachAdapter({ adapterName: this.config.name, adapterVersion: this.config.adapterVersion,
      runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION, profileName: input.profileName ?? this.config.profileName,
      hostHome: this.config.hostHome, managedFiles: [...nativeHostFiles(this.config), configFile(this.config.runtimeHome, this.config.name)],
      manifest: createWorkspaceManifest(input.workspaceRoot, input.workspaceId, this.config.name, input.hostVersion ?? this.identity.wrapperVersionFallback) });
  }
}
