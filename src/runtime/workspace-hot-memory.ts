import { createHash } from "crypto";

/** Existing hot-memory scopes support workspace partitions without a new API.
 * The readable runtime alias remains available to older/operator clients. */
export const workspaceHotScope = (runtime: string | undefined, workspaceId: string | null | undefined): string | undefined => {
	if (!workspaceId) return runtime;
	const body = (runtime || "shared").toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 16);
	const digest = createHash("sha256").update(JSON.stringify([runtime || "shared", workspaceId])).digest("hex").slice(0, 32);
	return `ws-${body}-${digest}`;
};

export const selectWorkspaceHotState = (
	partition: Record<string, unknown>, alias: Record<string, unknown>, workspaceId: string | null
): Record<string, unknown> => {
	if (!workspaceId) return alias;
	const belongs = (value: Record<string, unknown>): boolean => (value.workspaceId ?? value.workspace_id) === workspaceId;
	if (!belongs(partition)) return belongs(alias) ? alias : {};
	// A still-running older client may have written the alias more recently.
	if (belongs(alias) && Date.parse(String(alias.updatedAt)) > (Date.parse(String(partition.updatedAt)) || 0)) return alias;
	return partition;
};
