import { accessSync, chmodSync, constants, existsSync, readFileSync, rmSync } from "fs";
import path from "path";

import { assertManagedFilePath, parseArgs, shellQuote, writeManagedFile } from "./adapter-utils";
import { OMP_EXTENSION_SOURCE } from "./omp-extension-template";
import {
	installPiAdapter,
	ONLYBOTS_PI_ADAPTER_VERSION,
	resolvePiAdapterPaths,
	type PiAdapterInstallResult,
} from "./pi-adapter";

export const ONLYBOTS_OMP_PROJECT_ADAPTER_VERSION = ONLYBOTS_PI_ADAPTER_VERSION;

const OMP_EXTENSION_RELATIVE_PATH = "./.omp/extensions/onlybots.js";
const OMP_ENVRC_BEGIN = "# >>> onlybots omp >>>";
const OMP_ENVRC_END = "# <<< onlybots omp <<<";

// The embedded OMP source is a generated string. Apply the prompt trust
// boundary when materializing it so hosted lifecycle fields can never become
// Pi-compatible model instructions. Exact replacements intentionally fail
// closed if the generated template changes shape.
export const hardenOmpExtensionSource = (source: string, pinnedRuntimeHome?: string): string => {
	const safeRuntimeHomeResolver = pinnedRuntimeHome
		? `const resolveRuntimeHome = () => ${JSON.stringify(path.resolve(pinnedRuntimeHome))};`
		: [
			"const resolveRuntimeHome = (workspaceRoot) => {",
			"  const configuredHome = (process.env.CROSSHEAD_HOME ?? process.env.ONLYBOTS_HOME);",
			"  if (configuredHome && workspaceRoot === REPO_ROOT) return path.resolve(configuredHome);",
			"  throw new Error(`Crosshead runtime home is not pinned for this Pi-compatible workspace`);",
			"};",
		].join("\n");
	const replacements: ReadonlyArray<readonly [string, string]> = [
		[
			[
				"const entryWorkspaceId = (entry) => {",
				"  const direct = entry?.workspaceId ?? entry?.workspace_id;",
				'  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();',
				"  const parsed = parseJsonObject(entry?.content);",
				"  const nested = parsed?.workspaceId ?? parsed?.workspace_id;",
				'  return typeof nested === "string" && nested.trim().length > 0 ? nested.trim() : null;',
				"};",
			].join("\n"),
			[
				"const entryWorkspaceId = (entry) => {",
				"  const parsed = parseJsonObject(entry?.content);",
				"  const nested = parsed?.workspaceId ?? parsed?.workspace_id;",
				'  return typeof nested === "string" && nested.trim().length > 0 ? nested.trim() : null;',
				"};",
			].join("\n"),
		],
		[
			[
				"const resolveRuntimeHome = (workspaceRoot) => {",
				'  const workspaceHome = path.join(workspaceRoot, ".onlybots");',
				"  if (fs.existsSync(workspaceHome)) return workspaceHome;",
				"  if ((process.env.CROSSHEAD_HOME ?? process.env.ONLYBOTS_HOME) && workspaceRoot === REPO_ROOT) return (process.env.CROSSHEAD_HOME ?? process.env.ONLYBOTS_HOME);",
				'  const repoHome = path.join(REPO_ROOT, ".onlybots");',
				"  if (workspaceRoot === REPO_ROOT && fs.existsSync(repoHome)) return repoHome;",
				"  throw new Error(`Crosshead runtime home not found for Pi-compatible workspace: ${workspaceHome}`);",
				"};",
			].join("\n"),
			safeRuntimeHomeResolver,
		],
		[
			'    path.join(workspaceRoot, "dist", "runtime", "startup-context.js"),\n',
			"",
		],
		[
			[
				'      const baseContextText = typeof contextPack?.contextText === "string" ? contextPack.contextText : "";',
				"      const warnings = Array.isArray(response?.warnings) ? response.warnings : [];",
				'      let contextText = "";',
				"      if (this.startupContext) {",
				"        const manifest = this.startupContext.isContextPackManifest(contextPack?.manifest) ? contextPack.manifest : null;",
				"        const status = await this.status();",
				"        const freshness = this.startupContext.buildRuntimeStartupFreshness({",
			].join("\n"),
			[
				"      const warnings = Array.isArray(response?.warnings) ? response.warnings : [];",
				'      let contextText = "";',
				"      if (this.startupContext) {",
				"        const freshness = this.startupContext.buildRuntimeStartupFreshness({",
			].join("\n"),
		],
		[
			[
				"          status,",
				"          manifest,",
				"          inbox: response?.inbox ?? null,",
				"          dreamReview: response?.dreamReview ?? null,",
				"          obligations: response?.obligations ?? null,",
				"          actions: Array.isArray(response?.actions) ? response.actions : [],",
				"          warnings,",
				"          injectedContext: baseContextText,",
			].join("\n"),
			[
				"          status: null,",
				"          manifest: null,",
				"          inbox: null,",
				"          dreamReview: null,",
				"          obligations: null,",
				"          actions: [],",
				"          warnings: [],",
				'          injectedContext: "",',
			].join("\n"),
		],
		[
			"        contextText = baseContextText || renderHotMemoryFallback(hotMemorySnapshot);",
			"        contextText = renderHotMemoryFallback(hotMemorySnapshot);",
		],
	];
	let hardened = source;
	for (const [unsafe, safe] of replacements) {
		if (!hardened.includes(unsafe)) {
			throw new Error("OMP extension template changed before prompt-boundary hardening was applied");
		}
		hardened = hardened.replace(unsafe, safe);
	}
	return hardened;
};

export const OMP_INSTALLED_EXTENSION_SOURCE = hardenOmpExtensionSource(OMP_EXTENSION_SOURCE);

export type OmpProjectInstallOptions = {
	home?: string;
	profileName?: string;
	adapterVersion?: string;
	workspaceRoot?: string;
	ompBinary?: string;
	writeEnvrc?: boolean;
};

export type OmpProjectInstallResult = {
	pi: PiAdapterInstallResult;
	workspaceRoot: string;
	runtimeHome: string;
	ompBinary: string;
	launcherFile: string;
	configFile: string;
	extensionFile: string;
	envrcFile: string | null;
	managedFiles: string[];
};

export type OmpProjectUninstallOptions = {
	home?: string;
	workspaceRoot?: string;
};

export type OmpProjectUninstallResult = {
	runtimeHome: string;
	workspaceRoot: string;
	removedFiles: string[];
	updatedFiles: string[];
	piAdapterRetained: boolean;
};

const isExecutable = (filePath: string): boolean => {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const resolveOmpBinary = (runtimeHome: string, explicitBinary?: string): string => {
	if (explicitBinary) {
		return path.resolve(explicitBinary);
	}
	const executableName = process.platform === "win32" ? "omp.exe" : "omp";
	const blockedCandidates = new Set([path.join(runtimeHome, "bin", executableName)]);
	for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.resolve(entry, executableName);
		if (blockedCandidates.has(candidate)) {
			continue;
		}
		if (existsSync(candidate) && isExecutable(candidate)) {
			return candidate;
		}
	}
	throw new Error("Unable to resolve the real omp binary from PATH; pass --omp-bin <path>");
};

export const ensureOmpConfigExtension = (content: string | null): string => {
	const extensionLine = `  - ${OMP_EXTENSION_RELATIVE_PATH}`;
	if (!content || content.trim().length === 0) {
		return `extensions:\n${extensionLine}\n`;
	}
	if (content.includes(OMP_EXTENSION_RELATIVE_PATH) || content.includes(".omp/extensions/onlybots.js")) {
		return content.endsWith("\n") ? content : `${content}\n`;
	}
	const lines = content.split(/\r?\n/);
	const inlineExtensionsIndex = lines.findIndex((line) => /^extensions:\s*\[(.*)\]\s*(?:#.*)?$/.test(line));
	if (inlineExtensionsIndex >= 0) {
		const inlineMatch = lines[inlineExtensionsIndex]?.match(/^extensions:\s*\[(.*)\]\s*(?:#.*)?$/);
		const existingEntries =
			inlineMatch?.[1]
				.split(",")
				.map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
				.filter((entry) => entry.length > 0) ?? [];
		lines.splice(inlineExtensionsIndex, 1, "extensions:", ...existingEntries.map((entry) => `  - ${entry}`), extensionLine);
		return `${lines.join("\n").replace(/\n*$/, "")}\n`;
	}
	const extensionsIndex = lines.findIndex((line) => /^extensions:\s*(?:#.*)?$/.test(line));
	if (extensionsIndex >= 0) {
		lines.splice(extensionsIndex + 1, 0, extensionLine);
		return `${lines.join("\n").replace(/\n*$/, "")}\n`;
	}
	return `${content.replace(/\n*$/, "")}\n\nextensions:\n${extensionLine}\n`;
};

export const removeOmpConfigExtension = (content: string): string => {
	const extensionPattern = /^\s*-\s*['"]?\.\/\.omp\/extensions\/onlybots\.js['"]?\s*(?:#.*)?$/;
	const lines = content.split(/\r?\n/);
	const filtered = lines.filter((line) => !extensionPattern.test(line));
	if (filtered.length === lines.length) {
		return content;
	}

	for (let index = filtered.length - 1; index >= 0; index -= 1) {
		const line = filtered[index]!;
		if (!/^extensions:\s*$/.test(line)) {
			continue;
		}
		let hasRemainingEntry = false;
		for (let child = index + 1; child < filtered.length; child += 1) {
			const candidate = filtered[child]!;
			if (candidate.trim().length === 0 || candidate.trimStart().startsWith("#")) {
				continue;
			}
			hasRemainingEntry = /^\s+-\s+/.test(candidate);
			break;
		}
		if (!hasRemainingEntry) {
			filtered.splice(index, 1);
		}
	}

	const result = filtered.join("\n").replace(/^\n+|\n+$/g, "");
	return result.length > 0 ? `${result}\n` : "";
};


const ensureSourceableDirenvHelpers = (content: string): string => {
	if (!/(^|\n)\s*(source_up|PATH_add)\b/.test(content)) {
		return content;
	}
	if (content.includes("Crosshead shell helper fallbacks") || content.includes("OnlyBots shell helper fallbacks")) {
		return content;
	}
	return `# Crosshead shell helper fallbacks let this file work under plain source .envrc as well as direnv.
if ! command -v source_up >/dev/null 2>&1; then
  source_up() { :; }
fi
if ! command -v PATH_add >/dev/null 2>&1; then
  PATH_add() {
    case ":$PATH:" in
      *":$1:"*) ;;
      *) export PATH="$1\${PATH:+:$PATH}" ;;
    esac
  }
fi

${content}`;
};

export const ensureEnvrcOnlyBotsBlock = (content: string | null, runtimeHome: string): string => {
	const existing = ensureSourceableDirenvHelpers(content ?? "");
	const blockPattern = new RegExp(`\\n?${OMP_ENVRC_BEGIN}[\\s\\S]*?${OMP_ENVRC_END}\\n?`, "g");
	const withoutOldBlock = existing.replace(blockPattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
	const prefix = withoutOldBlock.length > 0 ? `${withoutOldBlock}\n\n` : "";
	return `${prefix}${OMP_ENVRC_BEGIN}
if ! command -v PATH_add >/dev/null 2>&1; then
  PATH_add() {
    case ":$PATH:" in
      *":$1:"*) ;;
      *) export PATH="$1\${PATH:+:$PATH}" ;;
    esac
  }
fi
export ONLYBOTS_HOME=${shellQuote(runtimeHome)}
export CROSSHEAD_HOME="$ONLYBOTS_HOME"
export ONLYBOTS_RUNTIME_HOME="$ONLYBOTS_HOME"
PATH_add "$ONLYBOTS_HOME/bin"
${OMP_ENVRC_END}
`;
};

export const removeEnvrcOnlyBotsBlock = (content: string): string => {
	const blockPattern = new RegExp(`\\n?${OMP_ENVRC_BEGIN}[\\s\\S]*?${OMP_ENVRC_END}\\n?`, "g");
	const result = content.replace(blockPattern, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return result.length > 0 ? `${result}\n` : "";
};

const isManagedOmpLauncher = (content: string, runtimeHome: string): boolean =>
	content.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n") &&
	content.includes("ONLYBOTS_OMP_WRAPPER_ACTIVE") &&
	content.includes(`export ONLYBOTS_HOME=${shellQuote(runtimeHome)}`) &&
	content.includes(`export ONLYBOTS_RUNTIME_HOME=${shellQuote(runtimeHome)}`);

const updateOrRemoveManagedFile = (options: {
	filePath: string;
	managedRoot: string;
	current: string;
	next: string;
	removedFiles: string[];
	updatedFiles: string[];
}): void => {
	if (options.current === options.next) {
		return;
	}
	if (options.next.length === 0) {
		rmSync(options.filePath, { force: true });
		options.removedFiles.push(options.filePath);
		return;
	}
	writeManagedFile(options.filePath, options.next, options.managedRoot);
	options.updatedFiles.push(options.filePath);
};

export const installOmpProjectAdapter = async (
	options: OmpProjectInstallOptions = {}
): Promise<OmpProjectInstallResult> => {
	const pi = await installPiAdapter({
		home: options.home,
		profileName: options.profileName,
		adapterVersion: options.adapterVersion,
	});
	const runtimeHome = pi.config.runtimeHome;
	const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
	const ompBinary = resolveOmpBinary(runtimeHome, options.ompBinary);
	const extensionFile = path.join(workspaceRoot, ".omp", "extensions", "onlybots.js");
	const configFile = path.join(workspaceRoot, ".omp", "config.yml");
	const launcherFile = path.join(runtimeHome, "bin", process.platform === "win32" ? "omp.cmd" : "omp");
	const envrcFile = path.join(workspaceRoot, ".envrc");

	assertManagedFilePath(configFile, workspaceRoot);
	if (options.writeEnvrc ?? true) assertManagedFilePath(envrcFile, workspaceRoot);
	writeManagedFile(extensionFile, hardenOmpExtensionSource(OMP_EXTENSION_SOURCE, runtimeHome), workspaceRoot);
	const existingOmpConfig = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
	writeManagedFile(configFile, ensureOmpConfigExtension(existingOmpConfig), workspaceRoot);
	writeManagedFile(
		launcherFile,
		`#!/usr/bin/env bash
set -euo pipefail

if [[ "\${ONLYBOTS_OMP_WRAPPER_ACTIVE:-0}" == "1" ]]; then
  exec ${shellQuote(ompBinary)} "$@"
fi

export ONLYBOTS_OMP_WRAPPER_ACTIVE=1
export ONLYBOTS_HOME=${shellQuote(runtimeHome)}
export CROSSHEAD_HOME="$ONLYBOTS_HOME"
export ONLYBOTS_RUNTIME_HOME=${shellQuote(runtimeHome)}

exec ${shellQuote(ompBinary)} "$@"
`,
		runtimeHome
	);
	chmodSync(launcherFile, 0o755);

	const managedFiles = [...pi.managedFiles, extensionFile, configFile, launcherFile];
	const shouldWriteEnvrc = options.writeEnvrc ?? true;
	if (shouldWriteEnvrc) {
		const existingEnvrc = existsSync(envrcFile) ? readFileSync(envrcFile, "utf8") : null;
		writeManagedFile(envrcFile, ensureEnvrcOnlyBotsBlock(existingEnvrc, runtimeHome), workspaceRoot);
		managedFiles.push(envrcFile);
	}

	return {
		pi,
		workspaceRoot,
		runtimeHome,
		ompBinary,
		launcherFile,
		configFile,
		extensionFile,
		envrcFile: shouldWriteEnvrc ? envrcFile : null,
		managedFiles,
	};
};

export const uninstallOmpProjectAdapter = async (
	options: OmpProjectUninstallOptions = {}
): Promise<OmpProjectUninstallResult> => {
	const runtimeHome = resolvePiAdapterPaths(options.home).runtimeHome;
	const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
	const extensionFile = path.join(workspaceRoot, ".omp", "extensions", "onlybots.js");
	const configFile = path.join(workspaceRoot, ".omp", "config.yml");
	const envrcFile = path.join(workspaceRoot, ".envrc");
	const launcherFile = path.join(runtimeHome, "bin", process.platform === "win32" ? "omp.cmd" : "omp");
	const removedFiles: string[] = [];
	const updatedFiles: string[] = [];

	const expectedExtension = hardenOmpExtensionSource(OMP_EXTENSION_SOURCE, runtimeHome);
	if (existsSync(extensionFile)) {
		assertManagedFilePath(extensionFile, workspaceRoot);
		if (readFileSync(extensionFile, "utf8") !== expectedExtension) {
			throw new Error(`Refusing to remove modified OMP extension: ${extensionFile}`);
		}
	}
	if (existsSync(launcherFile)) {
		assertManagedFilePath(launcherFile, runtimeHome);
		if (!isManagedOmpLauncher(readFileSync(launcherFile, "utf8"), runtimeHome)) {
			throw new Error(`Refusing to remove unmanaged OMP launcher: ${launcherFile}`);
		}
	}
	if (existsSync(configFile)) {
		assertManagedFilePath(configFile, workspaceRoot);
	}
	if (existsSync(envrcFile)) {
		assertManagedFilePath(envrcFile, workspaceRoot);
	}

	if (existsSync(extensionFile)) {
		rmSync(extensionFile, { force: true });
		removedFiles.push(extensionFile);
	}
	if (existsSync(launcherFile)) {
		rmSync(launcherFile, { force: true });
		removedFiles.push(launcherFile);
	}
	if (existsSync(configFile)) {
		const current = readFileSync(configFile, "utf8");
		updateOrRemoveManagedFile({
			filePath: configFile,
			managedRoot: workspaceRoot,
			current,
			next: removeOmpConfigExtension(current),
			removedFiles,
			updatedFiles,
		});
	}
	if (existsSync(envrcFile)) {
		const current = readFileSync(envrcFile, "utf8");
		updateOrRemoveManagedFile({
			filePath: envrcFile,
			managedRoot: workspaceRoot,
			current,
			next: removeEnvrcOnlyBotsBlock(current),
			removedFiles,
			updatedFiles,
		});
	}

	return {
		runtimeHome,
		workspaceRoot,
		removedFiles,
		updatedFiles,
		piAdapterRetained: existsSync(resolvePiAdapterPaths(runtimeHome).configFile),
	};
};

export const installOmpFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const result = await installOmpProjectAdapter({
		home: typeof flags.home === "string" ? flags.home : undefined,
		profileName: typeof flags.profile === "string" ? flags.profile : "default",
		adapterVersion: typeof flags.version === "string" ? flags.version : undefined,
		workspaceRoot: typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : undefined,
		ompBinary: typeof flags["omp-bin"] === "string" ? flags["omp-bin"] : undefined,
		writeEnvrc: flags["no-envrc"] === true ? false : undefined,
	});
	return [
		`Installed OMP project adapter ${result.pi.adapter.version}`,
		`runtime_home: ${result.runtimeHome}`,
		`workspace_root: ${result.workspaceRoot}`,
		`omp_bin: ${result.ompBinary}`,
		`omp_launcher: ${result.launcherFile}`,
		`omp_config: ${result.configFile}`,
		`omp_extension: ${result.extensionFile}`,
		...(result.envrcFile ? [`envrc: ${result.envrcFile}`] : []),
		"mode: pi-compatible OMP extension",
	].join("\n");
};

export const uninstallOmpFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const result = await uninstallOmpProjectAdapter({
		home: typeof flags.home === "string" ? flags.home : undefined,
		workspaceRoot: typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : undefined,
	});
	return [
		"Uninstalled OMP project adapter",
		`runtime_home: ${result.runtimeHome}`,
		`workspace_root: ${result.workspaceRoot}`,
		`removed_files: ${result.removedFiles.length}`,
		`updated_files: ${result.updatedFiles.length}`,
		...(result.piAdapterRetained
			? ["pi_adapter: retained (run `crosshead uninstall pi` separately if it is no longer needed)"]
			: []),
	].join("\n");
};
