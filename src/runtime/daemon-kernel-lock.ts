import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { acquireLocalHostedBridge } from "./local-hosted-bridge";

export type DaemonKernelLock = { alive(): boolean; close(): Promise<void> };

/** Darwin has neither Linux flock nor abstract Unix sockets. An exclusive
 * loopback listener is a kernel-owned lock that also releases on SIGKILL.
 * A port collision fails closed; we never evict a listener or probe its data.
 * No protocol or credentials are served on this socket. */
export const acquireLoopbackDaemonLock = async (home: string): Promise<DaemonKernelLock> => {
	const port = 16384 + createHash("sha256").update(`onlybots-daemon:${home}`).digest().readUInt32BE(0) % 32768;
	const server = createServer(socket => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", () => reject(new Error(`Daemon home is already controlled or ownership port ${port} is occupied`)));
		server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
	});
	let live = true;
	server.on("close", () => { live = false; });
	server.on("error", () => { live = false; server.close(); });
	return { alive: () => live && server.listening, close: async () => {
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	} };
};

export const acquireDaemonKernelLock = async (home: string, state: string): Promise<DaemonKernelLock> => {
	if (process.platform === "darwin") return acquireLoopbackDaemonLock(home);
	const suffix = createHash("sha256").update("onlybots-local-runtime-daemon").digest("hex").slice(0, 24);
	return acquireLocalHostedBridge(state, suffix);
};
