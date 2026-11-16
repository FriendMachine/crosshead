import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { generateRuntimeIdentity, OnlyBotsLocalRuntimeDaemon, setupRuntimeProfile } from "../../src/runtime/local-runtime";
import { writeLocalHotMemory } from "../../src/runtime/local-hot-memory";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";
import { workspaceHotScope } from "../../src/runtime/workspace-hot-memory";

const cliFile = path.resolve(__dirname, "../../dist/runtime/cli.js");

it("exports and imports a signed handoff after normal scoped project setup", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "crosshead-scoped-handoff-"));
	const home = path.join(root, "runtime");
	const project = path.join(root, "project");
	const otherProject = path.join(root, "other-project");
	const codexHome = path.join(root, "codex");
	const claudeHome = path.join(root, "claude");
	const capsuleFile = path.join(root, "capsule.json");
	for (const directory of [project, otherProject, codexHome, claudeHome]) mkdirSync(directory, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	const env = { ...process.env, CROSSHEAD_HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
	for (const key of ["CROSSHEAD_PROFILE", "ONLYBOTS_PROFILE", "ONLYBOTS_HOME", "ONLYBOTS_RUNTIME_HOME", "ONLYBOTS_CODEX_WRAPPER_ACTIVE"]) delete env[key];
	const cli = async (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliFile, ...args, "--json"], { cwd: project, env });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	let daemon: OnlyBotsLocalRuntimeDaemon | null = null;
	try {
		await setupRuntimeProfile({ home, profileName: "default", apiBase: "http://127.0.0.1:0", ...generateRuntimeIdentity(), makeDefault: true });
		const scopedIdentity = generateRuntimeIdentity();
		const scopedProfile = await setupRuntimeProfile({ home, profileName: "work", apiBase: "http://127.0.0.1:0", ...scopedIdentity, makeDefault: false });
		const setup = await cli("quickstart", "--scope", "project", "--adapter", "both", "--workspace-root", project,
			"--profile", "work", "--home", home, "--codex-home", codexHome, "--claude-home", claudeHome, "--no-start");
		expect(setup.status, setup.stdout + setup.stderr).toBe(0);
		expect(JSON.parse(setup.stdout).bindings).toHaveLength(2);
		daemon = new OnlyBotsLocalRuntimeDaemon(home);
		await daemon.start();
		const projectWideJudgment = vi.spyOn(daemon, "inspectContinuityJudgment").mockResolvedValue({
			snapshot: { projectModel: { currentDirection: [{ summary: "OTHER PROJECT PRIVATE DIRECTION" }] } },
		});
		const projectWideWarm = vi.spyOn(daemon, "listWarmMemory").mockResolvedValue({
			entries: [{ id: "other-project-warm-id" }],
		});
		const state = resolveRuntimePaths(home).state;
		const workspaceId = `repo:${project}`;
		const otherWorkspaceId = `repo:${otherProject}`;
		const checkpoint = (id: string, summary: string) => JSON.stringify({ runtime: "codex", workspaceId: id, continuityCheckpoints: [{
			runtime: "codex", workspaceId: id, sessionId: "prior", turnId: summary, goal: "Finish the task", summary,
			occurredAt: new Date().toISOString(),
		}] });
		writeLocalHotMemory(state, checkpoint(workspaceId, "This project's checksum still fails on empty rows"), workspaceHotScope("codex", workspaceId), scopedProfile);
		writeLocalHotMemory(state, checkpoint(otherWorkspaceId, "OTHER WORKSPACE SECRET"), workspaceHotScope("codex", otherWorkspaceId), scopedProfile);

		const exported = await cli("handoff", "export", "--source", "codex", "--target", "claude-code",
			"--workspace-root", project, "--session-id", "source-session", "--prompt", "Finish the scoped handoff",
			"--home", home, "--output", capsuleFile);
		expect(exported.status, exported.stdout + exported.stderr).toBe(0);
		expect(JSON.parse(exported.stdout).record.capsule.sourceRuntime).toBe("codex");
		expect(statSync(capsuleFile).mode & 0o777).toBe(0o600);
		const capsule = JSON.parse(readFileSync(capsuleFile, "utf8"));
		expect(capsule.targetRuntime).toBe("claude-code");
		expect(capsule.signature.signedBy).toBe(scopedIdentity.npub);
		expect(capsule.continuityIr.identity.npub).toBe(scopedIdentity.npub);
		expect(capsule.continuityIr.memoryReferences.hotMemory.summary).toContain("checksum still fails on empty rows");
		expect(JSON.stringify(capsule)).not.toContain("OTHER WORKSPACE SECRET");
		expect(JSON.stringify(capsule)).not.toContain("OTHER PROJECT PRIVATE DIRECTION");
		expect(JSON.stringify(capsule)).not.toContain("other-project-warm-id");
		expect(projectWideJudgment).not.toHaveBeenCalled();
		expect(projectWideWarm).not.toHaveBeenCalled();
		const oversizedFile = path.join(root, "oversized.json");
		writeFileSync(oversizedFile, " ".repeat(128 * 1024 + 1));
		for (const subcommand of ["import", "verify", "explain"]) {
			const oversized = await cli("handoff", subcommand, "--file", oversizedFile, "--home", home);
			expect(oversized.status).not.toBe(0);
			expect(JSON.parse(oversized.stdout).error.message).toContain("no larger than 131072 bytes");
		}
		const preservedFile = path.join(root, "preserved.txt");
		const forcedFile = path.join(root, "forced-capsule.json");
		writeFileSync(preservedFile, "keep this file");
		symlinkSync(preservedFile, forcedFile);
		const forced = await cli("handoff", "export", "--source", "codex", "--target", "claude-code",
			"--workspace-root", project, "--session-id", "source-session", "--prompt", "Export safely",
			"--home", home, "--output", forcedFile, "--force");
		expect(forced.status, forced.stdout + forced.stderr).toBe(0);
		expect(readFileSync(preservedFile, "utf8")).toBe("keep this file");
		expect(lstatSync(forcedFile).isSymbolicLink()).toBe(false);
		expect(statSync(forcedFile).mode & 0o777).toBe(0o600);
		const wrongWorkspace = await cli("handoff", "export", "--source", "codex", "--target", "claude-code",
			"--workspace-root", project, "--workspace-id", otherWorkspaceId, "--session-id", "source-session",
			"--prompt", "Export the other project", "--home", home);
		expect(wrongWorkspace.status).not.toBe(0);
		expect(JSON.parse(wrongWorkspace.stdout).error.message).toContain("workspace-id override");
		expect(wrongWorkspace.stdout).not.toContain("OTHER WORKSPACE SECRET");

		const imported = await cli("handoff", "import", "--target", "claude-code", "--file", capsuleFile,
			"--workspace-root", project, "--home", home);
		expect(imported.status, imported.stdout + imported.stderr).toBe(0);
		expect(JSON.parse(imported.stdout)).toMatchObject({ accepted: true, savedToHotMemory: true, verification: { valid: true } });
		const wrongImport = await cli("handoff", "import", "--target", "claude-code", "--file", capsuleFile,
			"--workspace-root", project, "--workspace-id", otherWorkspaceId, "--home", home);
		expect(wrongImport.status).not.toBe(0);
		expect(JSON.parse(wrongImport.stdout).error.message).toContain("workspace-id override");

		const wrongProfile = await cli("handoff", "export", "--source", "codex", "--target", "claude-code",
			"--workspace-root", project, "--session-id", "source-session", "--prompt", "Wrong profile",
			"--profile", "default", "--home", home);
		expect(wrongProfile.status).not.toBe(0);
		expect(JSON.parse(wrongProfile.stdout).error.message).toContain("This workspace uses profile work");
	} finally {
		vi.restoreAllMocks();
		if (daemon) await daemon.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
