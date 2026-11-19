import { readdirSync } from "node:fs";
import { HostedOnlyBotsClient, HostedOnlyBotsRequestError } from "./hosted-client";
import { isLocalOnlyRuntimeProfile } from "./local-hot-memory";
import type { RuntimeProfile } from "./local-runtime";
import { isRuntimeProfileName } from "./runtime-env";
import { isSessionWriteStale, loadProfile, loadSecret, saveSecret, type RuntimePaths } from "./runtime-persistence";
import { isRuntimeProfileForBinding } from "./runtime-profile-validation";
import { confirmUsageSync, prepareUsageSync, usageSyncIsCurrent } from "./token-usage";

export const canSyncTokenUsage = (profile: RuntimeProfile): boolean => !isLocalOnlyRuntimeProfile(profile);

export const syncTokenUsage = async (paths: RuntimePaths, profile: RuntimeProfile, force = false, signal?: AbortSignal): Promise<boolean> => {
	if (!canSyncTokenUsage(profile) || signal?.aborted) return false;
	const pending = await prepareUsageSync(paths, profile, Date.now(), force);
	if (!pending || signal?.aborted) return false;
	const { snapshot, digest } = pending;
	const secret = loadSecret(paths, profile.name);
	if (!secret) throw new Error("The agent key is missing. Run Crosshead setup for this profile.");
	const client = new HostedOnlyBotsClient({ apiBase: profile.apiBase, npub: profile.npub, nsec: secret.nsec, session: secret.session });
	const upload = async () => {
		await client.ensureSession(signal);
		if (!await usageSyncIsCurrent(paths, profile, snapshot) || signal?.aborted) return;
		const updated = loadProfile(paths, profile.name);
		if (updated?.npub !== profile.npub || updated.apiBase !== profile.apiBase) return;
		const saved = loadSecret(paths, profile.name);
		if (saved?.nsec === secret.nsec && saved.session?.sessionToken !== client.session()?.sessionToken &&
			!isSessionWriteStale(saved.session, client.session())) {
			saveSecret(paths, profile.name, { ...saved, session: client.session() });
		}
		return client.putTokenUsage(snapshot, signal);
	};

	let result: { stored: boolean } | undefined;
	try {
		try {
			result = await upload();
		} catch (error) {
			if (!(error instanceof HostedOnlyBotsRequestError) || error.status !== 401) throw error;
			client.setSession(null);
			result = await upload();
		}
	} catch (error) {
		if (error instanceof HostedOnlyBotsRequestError && error.status === 404) {
			throw new Error("This Crosshead server does not support usage sync yet.");
		}
		if (error instanceof HostedOnlyBotsRequestError && error.status === 409) {
			throw new Error("Link this agent to a console account with crosshead account link, then retry.");
		}
		throw error;
	}
	if (result?.stored !== true) return false;
	await confirmUsageSync(paths, profile, snapshot, digest);
	return true;
};

export const startTokenUsageSync = (paths: RuntimePaths): (() => Promise<void>) => {
	const stop = new AbortController();
	let running: Promise<void> | undefined;
	const syncProfiles = async () => {
		for (const filename of readdirSync(paths.profiles)) {
			if (stop.signal.aborted) break;
			if (!filename.endsWith(".json")) continue;
			const name = filename.slice(0, -5);
			if (!isRuntimeProfileName(name)) continue;
			try {
				const profile = loadProfile(paths, name);
				if (isRuntimeProfileForBinding(profile, name)) await syncTokenUsage(paths, profile, false, stop.signal);
			} catch {
				// A failed upload is retried on the next poll. The CLI can report the error on demand.
			}
		}
	};
	const poll = () => {
		if (running) return;
		running = syncProfiles().catch(() => undefined).finally(() => { running = undefined; });
	};
	const timer = setInterval(poll, 5 * 60_000).unref();
	return async () => {
		clearInterval(timer);
		stop.abort();
		await running;
	};
};
