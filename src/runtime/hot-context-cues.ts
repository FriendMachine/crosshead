export type HotContextActionCue = {
	text: string;
	validationCommand: string | null;
	paths: string[];
};

const COMMAND_PREFIX_PATTERN =
	/(?:^|[\s:;])((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[a-z0-9:_-]+|node\s+[a-z0-9_./-]+|npx\s+[a-z0-9_./:@-]+|pytest(?:\s+[a-z0-9_./:-]+)?|vitest(?:\s+[a-z0-9_./:-]+)?|make\s+[a-z0-9_./:-]+)/gi;

const PROJECT_PATH_PATTERN = /\b(?:src|test|tests|scripts)\/[a-zA-Z0-9._/-]+/g;

const truncateInline = (value: string, maxLength: number): string => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 14)).trimEnd()}... [truncated]`;
};

const normalizeCommandText = (value: string): string | null => {
	const normalized = value
		.replace(/^[$>]\s*/, "")
		.replace(/\s+/g, " ")
		.replace(/[),.;:]+$/g, "")
		.trim();
	return normalized.length > 0 ? normalized : null;
};

const commandPriority = (command: string): number => {
	const normalized = command.toLowerCase();
	let score = 0;
	if (/\bverify\b|\bbench\b|\bci\b|\bsmoke\b/.test(normalized)) {
		score += 8;
	}
	if (/^npm\s+run\s+/.test(normalized) || /^pnpm\s+run\s+/.test(normalized) || /^yarn\s+/.test(normalized)) {
		score += 2;
	}
	if (/\bintegration\b|\be2e\b|\bhidden\b/.test(normalized)) {
		score += 4;
	}
	if (/\btest\b/.test(normalized)) {
		score += 2;
	}
	if (/^npm\s+test\b/.test(normalized) || /^npm\s+run\s+test\b/.test(normalized)) {
		score -= 3;
	}
	return score;
};

const isValidationCommand = (command: string): boolean =>
	/\b(test|verify|bench|ci|smoke|check|vitest|pytest|e2e|integration)\b/i.test(command);

export const extractHotContextCommandCandidates = (value: string): string[] => {
	const commands: string[] = [];
	const normalized = value
		.replace(/```[a-z0-9_-]*\s*([\s\S]*?)```/gi, "\n$1\n")
		.replace(/`([^`\n]+)`/g, " $1 ");
	COMMAND_PREFIX_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = COMMAND_PREFIX_PATTERN.exec(normalized)) !== null) {
		const command = normalizeCommandText(match[1] ?? "");
		if (command && !commands.includes(command)) {
			commands.push(command);
		}
	}
	return commands;
};

export const pickHotContextValidationCommand = (value: string): string | null => {
	const commands = extractHotContextCommandCandidates(value).filter(isValidationCommand);
	if (commands.length === 0) {
		return null;
	}
	return [...commands].sort((left, right) => commandPriority(right) - commandPriority(left) || left.localeCompare(right))[0] ?? null;
};

export const mentionsHotContextInsufficientNpmTest = (value: string): boolean => {
	const normalized = value.toLowerCase().replace(/`/g, "");
	return /\bnpm\s+(?:run\s+)?test\s+(?:(?:is|was|remains)\s+)?(?:insufficient|not enough|misses|does not cover|doesn't cover|only covers)\b/.test(normalized);
};

export const extractHotContextProjectPaths = (value: string | null, maxPaths: number = 2): string[] => {
	if (!value) {
		return [];
	}
	const paths: string[] = [];
	PROJECT_PATH_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PROJECT_PATH_PATTERN.exec(value)) !== null) {
		const filePath = (match[0] ?? "").replace(/[),.;:]+$/g, "");
		if (filePath && !paths.includes(filePath)) {
			paths.push(filePath);
		}
		if (paths.length >= maxPaths) {
			break;
		}
	}
	return paths;
};

const splitEvidenceUnits = (value: string): string[] =>
	value
		.replace(/\r/g, "")
		.split(/\n+|(?<=[.!?])\s+/)
		.map((entry) => entry.replace(/^[-*]\s*/, "").trim())
		.filter(Boolean);

const scoreUnit = (unit: string, patterns: RegExp[]): number => {
	const lower = unit.toLowerCase();
	return patterns.reduce((score, pattern) => score + (pattern.test(lower) ? 1 : 0), 0);
};

const pickEvidenceUnit = (value: string, patterns: RegExp[], maxLength: number): string | null => {
	const units = splitEvidenceUnits(value)
		.map((unit, index) => ({ unit, index, score: scoreUnit(unit, patterns) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	return units[0] ? truncateInline(units[0].unit, maxLength) : null;
};

export const extractHotContextFailureHint = (value: string | null, maxLength: number = 180): string | null => {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return null;
	}
	const scored = splitEvidenceUnits(normalized)
		.map((sentence, index) => {
			const lower = sentence.toLowerCase();
			const score =
				(lower.includes("failure") || lower.includes("fails") || lower.includes("failing") ? 4 : 0) +
				(lower.includes("assertion") || lower.includes("expected") || lower.includes("actual") ? 3 : 0) +
				(lower.includes("integration") || lower.includes("ci") || lower.includes("verifier") ? 2 : 0) +
				(lower.includes("because") ? 1 : 0);
			return { sentence, index, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || right.index - left.index);
	return scored[0] ? truncateInline(scored[0].sentence, maxLength) : null;
};

export const buildHotContextActionCue = (value: string | null, maxLength: number = 420): HotContextActionCue | null => {
	if (!value || value.trim().length === 0) {
		return null;
	}
	const validationCommand = pickHotContextValidationCommand(value);
	const avoidCommand =
		validationCommand && mentionsHotContextInsufficientNpmTest(value) && !/^npm\s+(?:run\s+)?test\b/i.test(validationCommand)
			? "npm test"
			: null;
	const finding =
		pickEvidenceUnit(
			value,
			[
				/\btake[s]?\s+precedence\b|\bmust\s+take\s+precedence\b/,
				/\broot cause\b|\blikely root cause\b|\bcritical finding\b/,
				/\brequirements?\b|\bmust\b|\bexact\b|\bboundary\b/,
			],
			180
		) ?? extractHotContextFailureHint(value, 180);
	const preserve = pickEvidenceUnit(
		value,
		[
			/\bpublic api\b/,
			/\bexported\b|\bexports?\b|\bmodule\.exports\b/,
			/\bpreserve\b.*\bapi\b|\bapi\b.*\bpreserve\b/,
			/\bdo not add dependencies\b|\bno new dependencies\b/,
		],
		90
	);
	const avoid = pickEvidenceUnit(
		value,
		[
			/\bfailed approach\b/,
			/\bto avoid\b|\bavoid\b/,
			/\bdo not\b|\bdon't\b/,
			/\binsufficient\b|\bnot enough\b/,
		],
		100
	);
	const paths = extractHotContextProjectPaths(value);
	const parts = [
		validationCommand ? `validate with \`${validationCommand}\`` : null,
		avoidCommand ? `\`${avoidCommand}\` is insufficient here` : null,
		finding ? `finding=${finding}` : null,
		paths.length > 0 ? `inspect ${paths.join(", ")}` : null,
		preserve ? `preserve=${preserve}` : null,
		avoid && avoid !== preserve && avoid !== finding ? `avoid=${avoid}` : null,
	].filter((entry): entry is string => entry !== null);
	if (parts.length === 0) {
		return null;
	}
	return {
		text: truncateInline(parts.join("; "), maxLength),
		validationCommand,
		paths,
	};
};
