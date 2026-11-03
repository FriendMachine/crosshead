#!/usr/bin/env node
// Builds the release artifacts from an existing `dist/` (run `npm run build` first):
//
//   release/crosshead-runtime-install-<version>.tgz  install tarball served by
//       crosshead.sh/install. Layout is fixed by already-installed clients:
//       package.json, package-lock.json and dist/** at the archive root.
//   release/crosshead-runtime-<version>.tgz          npm package @crosshead/runtime
//   release/crosshead-protocol-<version>.tgz         npm package @crosshead/protocol
//   release/crosshead-release.json                   manifest with digests and source
//   release/SHA256SUMS
//
// Archives are reproducible: same sources and lockfile give the same bytes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const tar = require("tar");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = path.join(root, "release");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

const REQUIRED_ENTRIES = [
	"cli", "daemon", "local-runtime", "codex-adapter", "claude-code-adapter", "pi-adapter",
	"codex-bridge", "codex-hook", "claude-code-bridge", "claude-code-hook",
].map((name) => `dist/runtime/${name}.js`);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const walk = (dir) =>
	readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});

for (const required of REQUIRED_ENTRIES) {
	if (!existsSync(path.join(root, required))) {
		throw new Error(`Missing ${required}; run npm run build first`);
	}
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Install tarball: compiled JavaScript only, sorted, without timestamps.
const installFiles = [
	"LICENSE",
	"TRADEMARKS.md",
	"package.json",
	"package-lock.json",
	...walk(path.join(root, "dist"))
		.filter((file) => file.endsWith(".js"))
		.map((file) => path.relative(root, file).split(path.sep).join("/")),
].sort();
const installName = `crosshead-runtime-install-${version}.tgz`;
const installPath = path.join(outDir, installName);
await tar.c({ gzip: { level: 9 }, cwd: root, portable: true, noMtime: true, file: installPath }, installFiles);

// 2. npm packages. npm pack normalizes timestamps and ordering.
const npmPack = (cwd) =>
	JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], { cwd, encoding: "utf8" }))[0].filename;
const runtimePackageName = npmPack(root);

const protocolDir = path.join(outDir, ".protocol");
mkdirSync(path.join(protocolDir, "dist"), { recursive: true });
cpSync(path.join(root, "dist", "protocol"), path.join(protocolDir, "dist"), { recursive: true });
cpSync(path.join(root, "schemas"), path.join(protocolDir, "schemas"), { recursive: true });
cpSync(path.join(root, "packages", "protocol", "README.md"), path.join(protocolDir, "README.md"));
cpSync(path.join(root, "LICENSE"), path.join(protocolDir, "LICENSE"));
cpSync(path.join(root, "TRADEMARKS.md"), path.join(protocolDir, "TRADEMARKS.md"));
writeFileSync(
	path.join(protocolDir, "package.json"),
	`${JSON.stringify(
		{
			name: "@crosshead/protocol",
			version,
			description: "Crosshead wire contract: API shapes, schema versions, signed-record validators and JSON schemas.",
			license: pkg.license,
			private: pkg.private,
			homepage: pkg.homepage,
			repository: pkg.repository,
			engines: pkg.engines,
			files: ["dist", "schemas", "README.md", "LICENSE", "TRADEMARKS.md"],
		},
		null,
		2
	)}\n`
);
const protocolPackageName = npmPack(protocolDir);
rmSync(protocolDir, { recursive: true, force: true });

// 3. Manifest and checksums.
const describe = (file) => {
	const buffer = readFileSync(path.join(outDir, file));
	return { file, sha256: sha256(buffer), bytes: buffer.length };
};
const install = describe(installName);
const git = (args) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};
const manifest = {
	schemaVersion: "crosshead.release/v1",
	name: pkg.name,
	version,
	// Installed clients reuse lib/runtime/<releaseId> when it exists, so the id
	// must change whenever the install tarball changes.
	releaseId: `${version}-${install.sha256.slice(0, 12)}`,
	node: pkg.engines.node,
	source: {
		repository: process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : null,
		commit: process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]),
		dirty: git(["status", "--porcelain"]) ? true : false,
	},
	artifacts: {
		install,
		runtimePackage: describe(runtimePackageName),
		protocolPackage: describe(protocolPackageName),
	},
};
writeFileSync(path.join(outDir, "crosshead-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
	path.join(outDir, "SHA256SUMS"),
	Object.values(manifest.artifacts).map((artifact) => `${artifact.sha256}  ${artifact.file}\n`).join("")
);

console.log(`Built Crosshead ${version} release ${manifest.releaseId}`);
for (const artifact of Object.values(manifest.artifacts)) {
	console.log(`  ${artifact.file}  ${artifact.bytes} bytes  sha256:${artifact.sha256}`);
}
