import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { posix as path } from "node:path";

const ownedDirectory = async (directory: string, mode: number): Promise<void> => {
	const stat = await lstat(directory);
	if (!stat.isDirectory() || (stat.mode & 0o777) !== mode ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error("Local bridge directory is not owned and protected");
	}
};

/** The traversable mount contains only this attempt's endpoints. Its parents
 * remain owner-only on the host; no sibling attempt or controller files mount. */
export const assertLocalSocketDirectory = async (socketPath: string): Promise<void> => {
	const directory = path.dirname(socketPath);
	const stat = await lstat(directory);
	if ((stat.mode & 0o777) === 0o700) return ownedDirectory(directory, 0o700);
	if (path.basename(directory) !== "io" ||
		!/^[a-f0-9]{24,32}$/.test(path.basename(path.dirname(directory)))) {
		throw new Error("Local bridge endpoint directory is invalid");
	}
	await ownedDirectory(directory, 0o711);
	await ownedDirectory(path.dirname(directory), 0o700);
	await ownedDirectory(path.dirname(path.dirname(directory)), 0o700);
};

export type LocalHostedBridge = {
	directory: string;
	alive(): boolean;
	close(): Promise<void>;
};

/** Kernel flock lives with a pipe-fed cat process. Parent death closes the
 * pipe and releases the lock, including SIGKILL; there is no stale PID lease
 * or second authoritative work ledger. All lifecycle state stays in Crosshead. */
export const acquireLocalHostedBridge = async (
	root: string,
	suffix: string,
): Promise<LocalHostedBridge> => {
	if (!/^[a-f0-9]{24,32}$/.test(suffix)) throw new Error("Local bridge binding is invalid");
	await ownedDirectory(root, 0o700);
	const parent = path.join(root, suffix);
	await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	await ownedDirectory(parent, 0o700);
	const lockPath = path.join(parent, "controller.lock");
	const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("Local bridge lock is invalid");
		}
	} finally { await file.close(); }
	const child = spawn("/usr/bin/flock", ["--nonblock", lockPath, "/bin/cat"], {
		shell: false, stdio: ["pipe", "pipe", "ignore"],
	});
	let alive = true;
	const terminal = new Promise<void>((resolve) => {
		child.once("close", () => { alive = false; resolve(); });
		child.once("error", () => { alive = false; resolve(); });
	});
	child.stdin.on("error", () => undefined);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Local bridge lock timed out")), 2_000);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString("utf8");
				if (output === "locked\n") { clearTimeout(timer); resolve(); }
				else if (output.length > 32) { clearTimeout(timer); reject(new Error("Local bridge lock failed")); }
			});
			void terminal.then(() => { clearTimeout(timer); reject(new Error("Local bridge is already controlled")); });
			child.stdin.write("locked\n");
		});
		const directory = path.join(parent, "io");
		await mkdir(directory, { mode: 0o711 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const stat = await lstat(directory);
		if (!stat.isDirectory() || ![0o700, 0o711].includes(stat.mode & 0o777) ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("Local bridge endpoint directory is not protected");
		}
		// mkdir is filtered by an owner-only process umask. Only this owned
		// endpoint directory becomes traversable; its two parents remain 0700.
		await chmod(directory, 0o711);
		await ownedDirectory(directory, 0o711);
		return {
			directory,
			alive: () => alive,
			close: async () => { child.stdin.end(); await terminal; },
		};
	} catch (error) {
		child.stdin.end();
		await terminal;
		throw error;
	}
};

/** Call only while holding the attempt's bridge lock. Never replace a live
 * listener, symlink, regular file or socket owned by a different host user. */
export const removeStaleLocalSocket = async (socketPath: string): Promise<void> => {
	await assertLocalSocketDirectory(socketPath);
	let stat;
	try { stat = await lstat(socketPath); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error("Local bridge endpoint cannot be replaced");
	}
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection({ path: socketPath });
		socket.setTimeout(500);
		socket.once("connect", () => { socket.destroy(); reject(new Error("Local bridge endpoint is live")); });
		socket.once("timeout", () => { socket.destroy(); reject(new Error("Local bridge endpoint state is unknown")); });
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED") resolve(); else reject(error);
		});
	});
	const current = await lstat(socketPath);
	if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Local bridge endpoint changed");
	await unlink(socketPath);
};
