import { describe, expect, it } from "vitest";

import { formatDreamInspection, formatDreamReviewResult } from "../../src/runtime/local-runtime";

describe("dream review CLI formatting", () => {
	it("renders a concise inbox with evidence, scope, preview, and review command", () => {
		const output = formatDreamInspection({
			counts: {
				pending: 1,
				approved: 0,
				rejected: 0,
				superseded: 0,
			},
			runs: [
				{
					runId: "dream-run-cli",
					trigger: "operator",
					status: "completed",
					summary: { totalProposals: 1 },
				},
			],
			inbox: {
				pendingCount: 1,
				blockingPendingCount: 1,
				stalePendingCount: 0,
				items: [
					{
						proposalId: "dream-proposal-cli",
						runId: "dream-run-cli",
						status: "pending",
						proposalType: "warm_memory",
						proposedDurableWording:
							"Verify Cloud Run traffic and production smoke before marking deployment tasks done.",
						evidenceRefs: ["outcome:deploy-1"],
						confidence: 0.82,
						scope: {
							targetRefs: [],
							sourceRefs: ["outcome:deploy-1"],
							preferredRuntimeHosts: ["codex"],
							tags: ["dream:resolution"],
						},
						promotionType: "warm_memory:create_entry:pattern",
						rejectionRisks: [],
						appliedArtifactPreview: [
							{
								kind: "warm_entry",
								action: "create",
								entryType: "pattern",
								targetId: null,
								content: "Verify Cloud Run traffic and production smoke before marking deployment tasks done.",
								tags: ["dream:approved"],
								note: null,
							},
						],
					},
				],
			},
			proposals: [],
		});

		expect(output).toMatchInlineSnapshot(`
			"dreaming
			runs: 1
			pending: 1
			approved: 0
			rejected: 0
			superseded: 0
			inbox: pending=1 blocking=1 stale=0
			- run dream-run-cli trigger=operator status=completed proposals=1
			- dream-proposal-cli [pending] warm_memory confidence=0.82 promotion=warm_memory:create_entry:pattern
			  wording: Verify Cloud Run traffic and production smoke before marking deployment tasks done.
			  evidence: outcome:deploy-1
			  scope: targets=none sources=outcome:deploy-1 hosts=codex tags=dream:resolution
			  preview: create warm_entry pattern Verify Cloud Run traffic and production smoke before marking deployment tasks done.
			  rejection_risks: none
			  detail: crosshead context dreams inspect --proposal-id dream-proposal-cli --json"
		`);
	});

	it("renders merge and supersede targets in review results", () => {
		expect(
			formatDreamReviewResult({
				proposal: {
					proposalId: "dream-proposal-source",
					status: "superseded",
					proposalType: "warm_memory",
					summary: "Duplicate proposal.",
					latestReview: {
						decision: "merge",
						mergedIntoProposalId: "dream-proposal-target",
						appliedArtifacts: [],
					},
				},
			})
		).toContain("merged_into: dream-proposal-target");
	});
});
