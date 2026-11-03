#!/usr/bin/env node
// Enforces the package boundary:
// - src/protocol is self-contained: it imports only other protocol modules and
//   Node built-ins, so @crosshead/protocol can be published on its own.
// - src/runtime imports only runtime/protocol modules, Node built-ins and the
//   dependencies declared in package.json.
// - No relative import leaves src/.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const walk = (dir) =>
	readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
	});

const resolveRelative = (from, specifier) => {
	const base = path.resolve(path.dirname(from), specifier);
	return [`${base}.ts`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate)) ?? null;
};

const packageName = (specifier) =>
	specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

const failures = [];
const srcRoot = path.join(root, "src");
for (const file of walk(srcRoot)) {
	const rel = path.relative(root, file);
	const area = rel.split(path.sep)[1];
	const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
	for (const { fileName: specifier } of importedFiles) {
		if (specifier.startsWith(".")) {
			const target = resolveRelative(file, specifier);
			if (!target) {
				failures.push(`${rel}: unresolved import ${specifier}`);
				continue;
			}
			const targetRel = path.relative(root, target);
			if (!targetRel.startsWith(`src${path.sep}`)) {
				failures.push(`${rel}: import escapes src/: ${specifier}`);
				continue;
			}
			const targetArea = targetRel.split(path.sep)[1];
			if (area === "protocol" && targetArea !== "protocol") {
				failures.push(`${rel}: protocol must not import ${targetRel}`);
			}
			continue;
		}
		if (builtins.has(specifier) || builtins.has(packageName(specifier))) continue;
		if (area === "protocol") {
			failures.push(`${rel}: protocol must not depend on package ${specifier}`);
		} else if (!declared.has(packageName(specifier))) {
			failures.push(`${rel}: undeclared dependency ${specifier}`);
		}
	}
}

if (failures.length > 0) {
	console.error(`Boundary check failed (${failures.length}):\n${failures.map((line) => `  ${line}`).join("\n")}`);
	process.exit(1);
}
console.log("Boundary check passed: protocol is self-contained; runtime uses only declared dependencies.");
