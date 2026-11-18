import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;
export type UsageHost = "claude-code" | "codex";
export type TokenCounts = {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};
export type UsageEvent = {
	key: string;
	at: number;
	model: string;
	subagent: boolean;
	counts: TokenCounts;
};
export type UsageSource = { file: string; session: string; subagent: boolean; rootSession?: string };
export type UsageCursor = {
	fileId: string;
	offset: number;
	model?: string;
	codexTurn?: string;
	usesNativeCounts?: boolean;
	codexTotal?: TokenCounts;
};

const object = (value: unknown): JsonObject | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const string = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const model = (value: unknown): string | undefined =>
	typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:\/+-]{0,127}$/.test(value) ? value : undefined;
const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const usageKey = (...parts: (string | number)[]): string =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const readCounts = (value: unknown, host: UsageHost, outputIncludesReasoning = true): TokenCounts | undefined => {
	const usage = object(value);
	if (!usage) return undefined;
	const input = count(usage.input_tokens);
	const output = count(usage.output_tokens);
	if (input === undefined || output === undefined) return undefined;
	const claude = host === "claude-code";
	const cached = count(claude ? usage.cache_read_input_tokens : usage.cached_input_tokens) ?? 0;
	const written = count(claude ? usage.cache_creation_input_tokens : usage.cache_write_input_tokens) ?? 0;
	const reasoning = count(claude ? object(usage.output_tokens_details)?.thinking_tokens : usage.reasoning_output_tokens) ?? 0;
	const inputTokens = claude ? input + cached + written : input;
	const outputTokens = outputIncludesReasoning ? output : output + reasoning;
	if (cached > inputTokens || written > inputTokens || reasoning > outputTokens || !Number.isSafeInteger(inputTokens + outputTokens)) {
		return undefined;
	}
	return { inputTokens, cachedInputTokens: cached, cacheWriteInputTokens: written, outputTokens, reasoningOutputTokens: reasoning };
};

const equalCounts = (left: TokenCounts, right: TokenCounts): boolean =>
	(Object.keys(left) as (keyof TokenCounts)[]).every(key => left[key] === right[key]);

const subtractCounts = (total: TokenCounts, before: TokenCounts): TokenCounts | undefined => {
	if ((Object.keys(total) as (keyof TokenCounts)[]).some(key => total[key] < before[key])) return undefined;
	return {
		inputTokens: total.inputTokens - before.inputTokens,
		cachedInputTokens: total.cachedInputTokens - before.cachedInputTokens,
		cacheWriteInputTokens: total.cacheWriteInputTokens - before.cacheWriteInputTokens,
		outputTokens: total.outputTokens - before.outputTokens,
		reasoningOutputTokens: total.reasoningOutputTokens - before.reasoningOutputTokens,
	};
};

const readJson = (line: Buffer): JsonObject | undefined => {
	try { return object(JSON.parse(line.toString("utf8"))); } catch { return undefined; }
};

const openTranscript = (file: string): number =>
	openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
const optionalFileError = (error: unknown): boolean =>
	["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "");

const MAX_USAGE_LINE = 8 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

// Track byte offsets so a split UTF-8 sequence or incomplete tail is read again
// when the host finishes writing the row. Do not accumulate an oversized line.
const readLines = (fd: number, start: number, end: number, visit: (line: Buffer) => void): number => {
	const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
	let complete = start;
	let fragments: Buffer[] = [];
	let length = 0;
	for (let position = start; position < end;) {
		const size = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
		if (!size) break;
		const chunk = buffer.subarray(0, size);
		for (let index = 0; index < size;) {
			const newline = chunk.indexOf(10, index);
			const part = chunk.subarray(index, newline === -1 ? size : newline);
			length += part.length;
			if (length <= MAX_USAGE_LINE) {
				if (newline === -1) fragments.push(Buffer.from(part));
				else visit(fragments.length ? Buffer.concat([...fragments, part], length) : part);
			} else {
				fragments = [];
			}
			if (newline === -1) break;
			complete = position + newline + 1;
			index = newline + 1;
			length = 0;
			fragments = [];
		}
		position += size;
	}
	return complete;
};

const codexEvent = (row: JsonObject, source: UsageSource, cursor: UsageCursor, at: number): UsageEvent | undefined => {
	const payload = object(row.payload);
	if (!payload) return undefined;
	if (row.type === "turn_context") {
		const turnId = string(payload.turn_id);
		const turn = turnId ? usageKey(turnId) : undefined;
		if (turn && turn !== cursor.codexTurn) cursor.usesNativeCounts = false;
		cursor.codexTurn = turn;
		cursor.model = model(payload.model);
		return undefined;
	}
	if (row.type === "token_usage_record") {
		const recorded = string(payload.session_id);
		if (recorded && recorded !== source.session && recorded !== source.rootSession) return undefined;
		const id = string(payload.response_id);
		const counts = readCounts(payload.usage, "codex");
		if (!id || !counts) return undefined;
		cursor.usesNativeCounts = true;
		const thread = string(payload.thread_id);
		const delegated = thread !== undefined && thread !== source.session;
		return {
			key: usageKey("codex", id),
			at,
			model: model(payload.model) ?? (delegated ? undefined : cursor.model) ?? "unknown",
			subagent: source.subagent || delegated,
			counts,
		};
	}
	// New rollouts mirror exact records into the UI's token_count stream. A
	// rollout may contain older token_count rows from before a host upgrade.
	if (row.type !== "event_msg" || payload.type !== "token_count") return undefined;
	const info = object(payload.info);
	const total = readCounts(info?.total_token_usage, "codex");
	if (!total) return undefined;
	const before = cursor.codexTotal;
	cursor.codexTotal = total;
	if (cursor.usesNativeCounts || (before && equalCounts(before, total))) return undefined;
	const delta = before ? subtractCounts(total, before) : undefined;
	const last = readCounts(info?.last_token_usage, "codex", info?.last_usage_includes_reasoning !== false);
	const counts = last ?? delta;
	if (!counts) return undefined;
	return {
		key: usageKey("codex-legacy", source.session, at, ...Object.values(total)),
		at, model: cursor.model ?? "unknown", subagent: source.subagent, counts,
	};
};

const claudeEvent = (row: JsonObject, source: UsageSource, at: number): UsageEvent | undefined => {
	if (row.type !== "assistant") return undefined;
	const recordedSession = string(row.sessionId ?? row.session_id);
	if (recordedSession && recordedSession !== source.session) return undefined;
	const message = object(row.message);
	const id = string(message?.id);
	const counts = readCounts(message?.usage, "claude-code");
	if (!id || !counts) return undefined;
	return {
		key: usageKey("claude-code", id), at,
		model: model(message?.model) ?? "unknown",
		subagent: source.subagent || row.isSidechain === true,
		counts,
	};
};

export const scanUsageSource = (
	host: UsageHost, source: UsageSource, previous: UsageCursor | undefined, since: number,
	visit: (event: UsageEvent) => void
): UsageCursor | undefined => {
	let fd: number | undefined;
	try {
		fd = openTranscript(source.file);
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
		const fileId = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
		const size = Number(stat.size);
		const cursor = previous?.fileId === fileId && previous.offset <= size ? { ...previous } : { fileId, offset: 0 };
		cursor.offset = readLines(fd, cursor.offset, size, (line) => {
			const row = readJson(line);
			if (!row) return;
			const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
			// Older Codex rows still establish the model and cumulative baseline.
			const event = host === "codex" ? codexEvent(row, source, cursor, at) : claudeEvent(row, source, at);
			if (event && at >= since && (event.counts.inputTokens > 0 || event.counts.outputTokens > 0)) {
				visit(event);
			}
		});
		return cursor;
	} catch (error) {
		if (optionalFileError(error)) return undefined;
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const entries = (directory: string) => {
	try { return readdirSync(directory, { withFileTypes: true }); }
	catch (error) { if (optionalFileError(error)) return []; throw error; }
};

const claudeSources = (file: string, session: string): UsageSource[] => {
	const agents = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
	return [{ file, session, subagent: false }, ...entries(agents)
		.filter(entry => entry.isFile() && /^agent-.*\.jsonl$/.test(entry.name))
		.map(entry => ({ file: path.join(agents, entry.name), session, subagent: true }))];
};

type CodexMetadata = { id: string; parent: string | undefined; session: string | undefined; subagent: boolean };
const codexMetadata = (file: string): CodexMetadata | undefined => {
	let fd: number | undefined;
	try {
		fd = openTranscript(file);
		if (!fstatSync(fd).isFile()) return undefined;
		const first = Buffer.allocUnsafe(256 * 1024);
		const data = first.subarray(0, readSync(fd, first, 0, first.length, 0));
		const end = data.indexOf(10);
		if (end === -1) return undefined;
		const row = readJson(data.subarray(0, end));
		if (row?.type !== "session_meta") return undefined;
		const payload = object(row.payload);
		const id = string(payload?.id);
		if (!id) return undefined;
		const source = object(object(payload?.source)?.subagent);
		const parent = string(payload?.parent_thread_id) ?? string(object(source?.thread_spawn)?.parent_thread_id);
		return { id, parent, session: string(payload?.session_id), subagent: parent !== undefined || source !== undefined };
	} catch (error) {
		if (optionalFileError(error)) return undefined;
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const codexSources = (file: string, session: string, hostHome: string, since: number): UsageSource[] => {
	const main = codexMetadata(file);
	if (!main || main.id !== session || main.subagent) return [];
	const sources: UsageSource[] = [{ file, session, subagent: false }];
	const sessions = path.resolve(hostHome, "sessions");
	const relative = path.relative(sessions, file);
	if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return sources;

	// A resumed parent can spawn a child on a different day. Codex stores the
	// related rollouts in the same host home and identifies parents in session_meta.
	const firstDay = new Date(since - 86_400_000).toISOString().slice(0, 10);
	const candidates = new Map<string, { file: string; metadata: CodexMetadata }>();
	for (const year of entries(sessions).filter(entry => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
		const yearDir = path.join(sessions, year.name);
		for (const month of entries(yearDir).filter(entry => entry.isDirectory() && /^\d{2}$/.test(entry.name))) {
			const monthDir = path.join(yearDir, month.name);
			for (const day of entries(monthDir).filter(entry => entry.isDirectory() && /^\d{2}$/.test(entry.name))) {
				const folder = path.join(monthDir, day.name);
				const date = [year.name, month.name, day.name].join("-");
				for (const entry of entries(folder).filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))) {
					const candidate = path.join(folder, entry.name);
					if (candidate === file) continue;
					// Older rollouts can still receive new rows after a resume.
					if (date < firstDay && (statSync(candidate, { throwIfNoEntry: false })?.mtimeMs ?? 0) < since) continue;
					const metadata = codexMetadata(candidate);
					if (metadata?.subagent && metadata.parent) candidates.set(metadata.id, { file: candidate, metadata });
				}
			}
		}
	}
	const related = new Set([session]);
	for (let added = true; added;) {
		added = false;
		for (const [id, candidate] of candidates) {
			// New rollouts carry the root session ID. Older ones can link through
			// a chain of parent thread IDs instead.
			const { metadata } = candidate;
			if (metadata.session !== session && !related.has(metadata.parent!)) continue;
			sources.push({ file: candidate.file, session: id, rootSession: session, subagent: true });
			related.add(id);
			candidates.delete(id);
			added = true;
		}
	}
	return sources;
};

export const usageSources = (host: UsageHost, file: string, session: string, hostHome: string, since: number): UsageSource[] =>
	path.isAbsolute(file) && file.endsWith(".jsonl")
		? host === "claude-code" ? claudeSources(file, session) : codexSources(file, session, hostHome, since)
		: [];
