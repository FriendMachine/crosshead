import { readdirSync } from "node:fs";
import { hostedSessionMatches, normalizeApiBase, HostedOnlyBotsClient, HostedOnlyBotsRequestError, type HostedSession } from "./hosted-client";
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
	try {
		const secret = loadSecret(paths, profile.name);
		if (!secret) throw new Error("The agent key is missing. Run Crosshead setup for this profile.");
		const { serviceBaseUrl } = normalizeApiBase(profile.apiBase);
		const bound = (session: HostedSession | null): boolean => hostedSessionMatches(session, profile.npub, serviceBaseUrl);
		const client = new HostedOnlyBotsClient({
			apiBase: profile.apiBase, npub: profile.npub, nsec: secret.nsec, session: bound(secret.session) ? secret.session : null,
		});
		const upload = async () => {
			const session = await client.ensureSession(signal);
			if (!await usageSyncIsCurrent(paths, profile, snapshot) || signal?.aborted) return;
			const updated = loadProfile(paths, profile.name);
			const saved = loadSecret(paths, profile.name);
			if (updated?.npub !== profile.npub || updated.apiBase !== profile.apiBase || saved?.nsec !== secret.nsec) return;
			if (saved.session?.sessionToken !== session.sessionToken &&
				(!bound(saved.session) || !isSessionWriteStale(saved.session, session))) {
				saveSecret(paths, profile.name, { ...saved, session });
			}
			return client.putTokenUsage(snapshot, signal);
		};

		let result;
		try {
			result = await upload();
		} catch (error) {
			if (!(error instanceof HostedOnlyBotsRequestError) || error.status !== 401) throw error;
			client.setSession(null);
			result = await upload();
		}
		if (!result) return false;
		if (!result.stored) {
			throw new HostedOnlyBotsRequestError({
				status: 409, code: "usage_revision_stale", message: "The server already has a newer usage snapshot.",
			});
		}
		await confirmUsageSync(paths, profile, snapshot, { digest });
		return true;
	} catch (error) {
		if (signal?.aborted) return false;
		let message = "Usage upload failed. Check the Crosshead connection and try again.";
		if (error instanceof HostedOnlyBotsRequestError) {
			if (error.status === 404) message = "This Crosshead server does not support usage sync yet.";
			if (error.status === 409 && error.code === "usage_audience_changed") {
				message = "The account link changed. Run crosshead usage sync off and then on to share with the new link.";
			} else if (error.status === 409 && error.code === "usage_revision_stale") {
				message = "The server already has a newer usage snapshot for this installation.";
			} else if (error.status === 409) {
				message = "Link this agent to a console account with crosshead account link, then retry.";
			}
			if (error.status === 400) message = "The server rejected the usage snapshot. Check the device date and time.";
			if (error.status === 401 || error.status === 403) message = "The server did not authorize this agent to sync usage.";
		}
		await confirmUsageSync(paths, profile, snapshot, { error: message });
		throw new Error(message, { cause: error });
	}
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
