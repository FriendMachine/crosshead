import { describe, expect, it } from "vitest";
import { ownSessionTurnId, ownSessionTurnState } from "../../src/runtime/claude-code-hook";

const turn = (sessionId: string, turnId: string | null, updatedAt: string) => ({
	sessionId, turnId, prompt: `prompt ${turnId}`, packId: `pack ${turnId}`, workspaceRoot: "/repo", workspaceId: "w",
	lastContextReadAt: null, updatedAt,
});

describe("Claude Code turn selection without a payload turn ID", () => {
	// Sessions A and B share one state file; B prompted last, so the file's
	// top-level turn is B's. A's Stop must still resolve to A's own turn.
	const a1 = turn("A", "a1", "2026-11-18T10:00:00.000Z");
	const b1 = turn("B", "b1", "2026-11-18T10:01:00.000Z");
	const state = { ...b1, activeTurns: { "A:a0": turn("A", "a0", "2026-11-18T09:00:00.000Z"), "A:a1": a1, "B:b1": b1 } } as any;

	it("resolves the newest turn of the payload's own session, not the file's latest turn", () => {
		expect(ownSessionTurnId(state, "A")).toBe("a1");
		expect(ownSessionTurnId(state, "B")).toBe("b1");
	});
	it("finds no turn for a session that never prompted, and keeps the legacy fallback without a session", () => {
		expect(ownSessionTurnId(state, "C")).toBeNull();
		expect(ownSessionTurnId(state, null)).toBe("b1");
	});
	it("never hands one session another session's turn to finish or clear", () => {
		expect(ownSessionTurnState("A", a1)).toBe(a1);
		expect(ownSessionTurnState(null, b1)).toBe(b1);
		expect(ownSessionTurnState("C", b1)).toMatchObject({ sessionId: "C", turnId: null, prompt: null, packId: null, workspaceRoot: "/repo", workspaceId: "w" });
	});
});
