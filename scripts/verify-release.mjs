#!/usr/bin/env node
// Verifies built release artifacts before they are published or vendored.
//
//   node scripts/verify-release.mjs [release-dir] [--smoke]
//
// Checks digests against the manifest, the install tarball's layout and
// contents, and (with --smoke) installs it the way the installer does and runs
// the offline CLI.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tar = require("tar");
const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const releaseDir = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? "release");
const manifest = JSON.parse(readFileSync(path.join(releaseDir, "crosshead-release.json"), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);

// Paths every installed client requires (see local-runtime release install).
const REQUIRED = [
	"LICENSE", "TRADEMARKS.md", "package.json", "package-lock.json",
	...["cli", "daemon", "local-runtime", "codex-adapter", "claude-code-adapter", "pi-adapter",
		"codex-bridge", "codex-hook", "claude-code-bridge", "claude-code-hook",
		"native-host-adapter", "native-host-hook", "hermes-plugin", "opencode-plugin"].map((name) => `dist/runtime/${name}.js`),
];
const ALLOWED = /^(LICENSE|TRADEMARKS\.md|package\.json|package-lock\.json|dist\/(runtime|protocol)\/[A-Za-z0-9/_.-]+\.js)$/;
// Hosted-service code and credentials must never appear in a client release.
const FORBIDDEN_CONTENT = [
	/require\("\.\.\/(services|server|storage|repositories|infra|workers|ops)\//,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk_live_[A-Za-z0-9]{8,}/,
	/\bwhsec_[A-Za-z0-9]{8,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
];

for (const artifact of Object.values(manifest.artifacts)) {
	const buffer = readFileSync(path.join(releaseDir, artifact.file));
	const digest = createHash("sha256").update(buffer).digest("hex");
	if (digest !== artifact.sha256) fail(`${artifact.file}: sha256 ${digest} does not match manifest ${artifact.sha256}`);
	if (buffer.length !== artifact.bytes) fail(`${artifact.file}: size does not match manifest`);
}
if (manifest.releaseId !== `${manifest.version}-${manifest.artifacts.install.sha256.slice(0, 12)}`) {
	fail("releaseId must be <version>-<first 12 hex digits of the install tarball sha256>");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId)) fail("releaseId is not path-safe");

const installPath = path.join(releaseDir, manifest.artifacts.install.file);
const seen = new Set();
await tar.t({
	file: installPath,
	onentry: (entry) => {
		const name = entry.path.replace(/\\/g, "/");
		if (entry.type !== "File") {
			fail(`install tarball has non-file entry ${name} (${entry.type})`);
			return;
		}
		seen.add(name);
		if (!ALLOWED.test(name)) fail(`install tarball has unexpected path ${name}`);
		const chunks = [];
		entry.on("data", (chunk) => chunks.push(chunk));
		entry.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			for (const pattern of FORBIDDEN_CONTENT) {
				if (pattern.test(text)) fail(`${name} matches forbidden pattern ${pattern}`);
			}
			if (name === "package.json") {
				const pkg = JSON.parse(text);
				if (pkg.version !== manifest.version) fail("package.json version does not match manifest");
				if (pkg.license !== "Apache-2.0") fail("install package.json must declare Apache-2.0");
				const allowed = new Set(["@noble/curves", "nostr-tools", "tar"]);
				for (const dep of Object.keys(pkg.dependencies ?? {})) {
					if (!allowed.has(dep)) fail(`unexpected runtime dependency ${dep}; review and update the allowlist deliberately`);
				}
			}
		});
	},
});
for (const required of REQUIRED) {
	if (!seen.has(required)) fail(`install tarball is missing ${required}`);
}

for (const artifactName of ["runtimePackage", "protocolPackage"]) {
	const artifact = manifest.artifacts[artifactName];
	const entries = new Set();
	let declaredLicense = null;
	await tar.t({
		file: path.join(releaseDir, artifact.file),
		onentry: (entry) => {
			const name = entry.path.replace(/\\/g, "/");
			entries.add(name);
			if (name !== "package/package.json") return;
			const chunks = [];
			entry.on("data", (chunk) => chunks.push(chunk));
			entry.on("end", () => {
				declaredLicense = JSON.parse(Buffer.concat(chunks).toString("utf8")).license ?? null;
			});
		},
	});
	for (const required of ["package/LICENSE", "package/TRADEMARKS.md"]) {
		if (!entries.has(required)) fail(`${artifact.file}: missing ${required}`);
	}
	if (declaredLicense !== "Apache-2.0") fail(`${artifact.file}: package.json must declare Apache-2.0`);
}

if (smoke && failures.length === 0) {
	const stage = mkdtempSync(path.join(os.tmpdir(), "crosshead-release-smoke-"));
	try {
		await tar.x({ file: installPath, cwd: stage });
		execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "pipe" });
		const home = path.join(stage, "home");
		const output = execFileSync(process.execPath, [path.join(stage, "dist/runtime/cli.js"), "capabilities", "--json"], {
			cwd: stage,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: home, CROSSHEAD_HOME: home, ONLYBOTS_HOME: home },
		});
		const document = JSON.parse(output);
		if (!document || typeof document !== "object") fail("smoke: capabilities --json did not return a JSON object");
		const daemon = (() => {
			try {
				execFileSync(process.execPath, [path.join(stage, "dist/runtime/daemon.js"), "serve", "--home", home,
					"--organizational-worker-config", path.join(stage, "missing.json")], { stdio: "pipe" });
				return "started";
			} catch (error) {
				return String(error.stderr ?? error.message);
			}
		})();
		if (!daemon.includes("not supported by this Crosshead runtime build")) {
			fail("smoke: public daemon did not reject --organizational-worker-config");
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`Release verification failed (${failures.length}):\n${failures.map((line) => `  ${line}`).join("\n")}`);
	process.exit(1);
}
console.log(`Release ${manifest.releaseId} verified: ${seen.size} install entries${smoke ? ", smoke install passed" : ""}.`);
