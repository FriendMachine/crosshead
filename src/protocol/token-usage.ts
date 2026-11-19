export type UsageSnapshot = {
	deviceId: string;
	consentRevision: number;
	revision: number;
	rows: {
		day: string;
		harness: "claude-code" | "codex";
		model: string;
		inputTokens: number;
		cachedInputTokens: number;
		cacheWriteInputTokens: number;
		outputTokens: number;
		reasoningOutputTokens: number;
	}[];
};
