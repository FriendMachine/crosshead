/** Resolve renamed settings without changing the caller's environment.
 * CROSSHEAD_* wins even when explicitly empty (so it cannot revive an old secret).
 * Both names are exposed to existing internal parsers during the migration.
 */
export function crossheadEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
	const resolved = { ...source };
	for (const key of Object.keys(source)) {
		if (!key.startsWith("ONLYBOTS_") && !key.startsWith("CROSSHEAD_")) continue;
		const suffix = key.slice(key.indexOf("_") + 1);
		const canonical = `CROSSHEAD_${suffix}`;
		const legacy = `ONLYBOTS_${suffix}`;
		const value = source[canonical] ?? source[legacy];
		resolved[canonical] = value;
		resolved[legacy] = value;
	}
	return resolved;
}
