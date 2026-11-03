import type { ContinuityIr } from "../../src/runtime/continuity-ir";
import type { ClaudeCodeContinuityCapture } from "../../src/runtime/claude-code-adapter";
import type { CodexContinuityCapture } from "../../src/runtime/codex-adapter";

const transcript = [
  {
    role: "user" as const,
    content: "Move the signed handoff work forward without losing the open fidelity question.",
    timestamp: "2026-04-09T14:00:00.000Z",
  },
  {
    role: "assistant" as const,
    content: "The runtime-neutral IR must keep prompt transport loss explicit instead of hiding it.",
    timestamp: "2026-04-09T14:01:00.000Z",
  },
];

const toolResults = [
  {
    toolName: "bash",
    summary: "Compared Codex and Claude runtime lifecycle surfaces.",
    status: "ok" as const,
    callId: "host-tool-1",
  },
];

const sharedBase = {
  workspaceRoot: "/tmp/onlybots-erd",
  workspaceId: "repo:onlybots-erd",
  sessionId: "handoff-session",
  turnId: "handoff-turn-1",
  prompt: "Define the continuity IR and signed handoff translation contract.",
  hostVersion: "test-host-1.0.0",
  transcript,
  toolResults,
  activeFiles: ["src/runtime/codex-adapter.ts", "src/runtime/claude-code-adapter.ts"],
  identity: {
    agentId: "agent_onlybots",
    npub: "npub1onlybotsfixture",
    lineageRoot: "agent_onlybots",
  },
  task: {
    objective: "Define the continuity IR and signed handoff translation contract.",
    status: "in_progress" as const,
    openLoops: ["prove equivalent normalization across hosts", "document fidelity loss categories"],
    priority: 0.8,
  },
  reasoning: {
    currentTheory: "Prompt transport and host settings must downgrade cleanly while task state stays canonical.",
    openQuestions: ["How much fidelity loss is acceptable in v1 handoff capsules?"],
    rejectedPaths: ["embedding absolute host paths into the IR"],
    unresolvedRisks: ["operators could mistake advisory host config for preserved runtime state"],
    portabilityNotes: ["Codex and Claude prompt scaffolding differ but both can consume the same canonical context."],
    nextAction: "Ship the schema, contracts, and explicit fidelity report.",
  },
  memory: {
    hotSummary: "The current work is phase-1 handoff translation contracts for Codex and Claude Code.",
    warmIds: ["warm_handoff_contract", "warm_prompt_transport"],
    coldChunkIds: ["cold_handoff_fixture"],
    projectModelIds: ["project_model_handoff"],
    userModelIds: ["user_model_operator"],
    selfModelIds: ["self_model_onlybots"],
  },
  policy: {
    policyRef: "continuity_policy_v1:sha256:test",
    continuityPolicy: "runtime-neutral",
    enforcementHints: [
      {
        surface: "memory lifecycle",
        level: "runtime_enforced" as const,
        notes: "Crosshead enforces write thresholds in the runtime.",
      },
      {
        surface: "tool approval",
        level: "advisory" as const,
        notes: "Host tools remain host-controlled.",
      },
    ],
    memoryScope: {
      allowedWorkspaces: ["repo:onlybots-erd"],
      allowedTrustZones: ["work"],
    },
  },
  delegation: {
    whyTransfer: "The next runtime may offer a better execution surface without changing the durable task identity.",
    requestedCapabilities: ["repo_execution", "tool_use"],
    recommendedTarget: "claude-code" as const,
  },
  economics: {
    budgetRemainingSats: 320,
    costSoFarSats: 24,
    budgetHints: ["Prefer lightweight capsules with referenced warm memory in v1."],
  },
};

const codingBase = {
  ...sharedBase,
  sessionId: "handoff-coding-session",
  turnId: "handoff-coding-turn-1",
  prompt: "Implement Codex-to-Claude Code handoff receipts and import guidance.",
  activeFiles: ["src/services/handoffs.ts", "src/runtime/claude-code-adapter.ts", "src/runtime/codex-adapter.ts"],
  task: {
    objective: "Implement Codex-to-Claude Code handoff receipts and import guidance.",
    status: "in_progress" as const,
    openLoops: ["persist receiver receipts", "prove import rejection handling", "document operator flow"],
    priority: 0.9,
  },
  reasoning: {
    currentTheory: "The import path should reuse signed capsules and translation fidelity instead of inventing a parallel receipt format.",
    openQuestions: ["Should rejected imports persist a structured receiver receipt?"],
    rejectedPaths: ["storing host-private prompt scaffolding as semantic IR"],
    unresolvedRisks: ["operators could accept a handoff without seeing the manual re-establishment steps"],
    portabilityNotes: ["The Claude-side import should surface preserved, reference-only, and manual steps explicitly."],
    nextAction: "Wire live export and import flows through the runtime and adapters.",
  },
  memory: {
    hotSummary: "The active work is shipping end-to-end Codex-to-Claude handoff export and import flows.",
    warmIds: ["warm_handoff_receipt", "warm_import_guidance", "warm_runtime_flow"],
    coldChunkIds: ["cold_handoff_coding_fixture"],
    projectModelIds: ["project_model_handoff_delivery"],
    userModelIds: ["user_model_operator"],
    selfModelIds: ["self_model_onlybots"],
  },
  delegation: {
    whyTransfer: "Claude Code is taking over the implementation pass while retaining the Codex continuity state.",
    requestedCapabilities: ["repo_execution", "targeted_refactor", "test_validation"],
    recommendedTarget: "claude-code" as const,
  },
  economics: {
    budgetRemainingSats: 280,
    costSoFarSats: 41,
    budgetHints: ["Use the signed capsule plus warm references instead of manually rewriting the implementation state."],
  },
};

export const codexContinuityFixture = (): CodexContinuityCapture => ({
  runtime: "codex",
  ...sharedBase,
  hostHome: "/tmp/codex-home",
  managedSkillName: "onlybots-runtime",
  experimentalHooksEnabled: true,
  hookTransport: "additionalContext",
  managedFiles: [
    "/tmp/codex-home/hooks.json",
    "/tmp/codex-home/onlybots/codex-adapter.json",
  ],
});

export const claudeCodeContinuityFixture = (): ClaudeCodeContinuityCapture => ({
  runtime: "claude-code",
  ...sharedBase,
  hostHome: "/tmp/claude-home",
  printMode: false,
  projectSettingsManaged: true,
  promptTransport: "--append-system-prompt",
  managedFiles: [
    "/tmp/onlybots-erd/.claude/settings.json",
    "/tmp/claude-home/onlybots/claude-code-adapter.json",
  ],
});

export const codexCodingContinuityFixture = (): CodexContinuityCapture => ({
  runtime: "codex",
  ...codingBase,
  hostHome: "/tmp/codex-home",
  managedSkillName: "onlybots-runtime",
  experimentalHooksEnabled: true,
  hookTransport: "additionalContext",
  managedFiles: [
    "/tmp/codex-home/hooks.json",
    "/tmp/codex-home/onlybots/codex-adapter.json",
  ],
});

export const claudeCodeCodingContinuityFixture = (): ClaudeCodeContinuityCapture => ({
  runtime: "claude-code",
  ...codingBase,
  hostHome: "/tmp/claude-home",
  printMode: false,
  projectSettingsManaged: true,
  promptTransport: "--append-system-prompt",
  managedFiles: [
    "/tmp/onlybots-erd/.claude/settings.json",
    "/tmp/claude-home/onlybots/claude-code-adapter.json",
  ],
  delegation: {
    whyTransfer: "Codex is taking the implementation baton back with the updated Claude Code results attached.",
    requestedCapabilities: ["repo_execution", "targeted_refactor", "test_validation"],
    recommendedTarget: "codex",
  },
});

export const comparableContinuitySections = (ir: ContinuityIr) => ({
  identity: ir.identity,
  task: ir.task,
  reasoningState: ir.reasoningState,
  operationalContext: {
    workspaceId: ir.operationalContext.workspaceId,
    workspaceLabel: ir.operationalContext.workspaceLabel,
    sessionId: ir.operationalContext.sessionId,
    turnId: ir.operationalContext.turnId,
    currentPrompt: ir.operationalContext.currentPrompt,
    recentMessages: ir.operationalContext.recentMessages,
    toolResults: ir.operationalContext.toolResults,
    activeFiles: ir.operationalContext.activeFiles,
  },
  memoryReferences: ir.memoryReferences,
  policy: ir.policy,
  delegation: ir.delegation,
  economics: ir.economics,
});
