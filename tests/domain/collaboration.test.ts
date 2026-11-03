import { readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION,
  TYPED_INBOX_EVENT_SCHEMA_VERSION,
  assignmentInboxEventExample,
  collaborationContextExample,
  collaborationMessageEnvelopeExample,
  parseCollaborationMessageContent,
  serializeCollaborationMessageEnvelope,
  validateCollaborationContextMetadata,
  validateCollaborationMessageEnvelope,
  validateTypedInboxEvent,
} from "../../src/protocol/collaboration";

describe("collaboration contracts", () => {
  it("accepts the checked-in collaboration context and typed inbox event examples", () => {
    expect(validateCollaborationContextMetadata(collaborationContextExample)).toEqual([]);
    expect(validateTypedInboxEvent(assignmentInboxEventExample)).toEqual([]);
    expect(validateCollaborationMessageEnvelope(collaborationMessageEnvelopeExample)).toEqual([]);

    const contextSchema = JSON.parse(
      readFileSync(path.resolve("schemas/collaboration-context.schema.json"), "utf8")
    ) as { examples?: unknown[] };
    const eventSchema = JSON.parse(
      readFileSync(path.resolve("schemas/typed-inbox-event.schema.json"), "utf8")
    ) as { examples?: unknown[] };
    const envelopeSchema = JSON.parse(
      readFileSync(path.resolve("schemas/collaboration-message-envelope.schema.json"), "utf8")
    ) as { examples?: unknown[] };

    expect(contextSchema.examples?.[0]).toBeTruthy();
    expect(eventSchema.examples?.[0]).toBeTruthy();
    expect(envelopeSchema.examples?.[0]).toBeTruthy();
    expect(validateCollaborationContextMetadata(contextSchema.examples?.[0])).toEqual([]);
    expect(validateTypedInboxEvent(eventSchema.examples?.[0])).toEqual([]);
    expect(validateCollaborationMessageEnvelope(envelopeSchema.examples?.[0])).toEqual([]);
  });

  it("rejects mismatched envelope context ids and invalid governance payloads", () => {
    const invalidEnvelope = JSON.parse(JSON.stringify(collaborationMessageEnvelopeExample)) as typeof collaborationMessageEnvelopeExample;
    invalidEnvelope.inboxEvent.contextId = "ctx_other";
    expect(validateCollaborationMessageEnvelope(invalidEnvelope)).toEqual(
      expect.arrayContaining(["inboxEvent.contextId must match collaborationContext.contextId"])
    );

    const invalidGovernance = {
      schemaVersion: TYPED_INBOX_EVENT_SCHEMA_VERSION,
      eventId: "inbox_evt_governance_01",
      eventType: "operator_governance",
      contextId: "ctx_auth_refactor",
      summary: "Pause the context.",
      priority: "high",
      createdAt: "2026-04-19T00:05:00Z",
      actor: {
        npub: collaborationContextExample.createdBy,
        agentId: "agent_default",
        runtimeHost: "codex",
        role: "operator",
      },
      taskRef: "task-master:95",
      artifactRefs: [],
      handoffRefs: [],
      outcomeRefs: [],
      operatorGovernance: {
        action: "freeze_everything",
        note: "",
        affectedParticipantNpub: null,
      },
    };

    expect(validateTypedInboxEvent(invalidGovernance)).toEqual(
      expect.arrayContaining([
        "operatorGovernance.action must be one of pause_context, budget_ceiling_change, tool_restriction, memory_scope_change, participant_removal",
        "operatorGovernance.note is required",
      ])
    );
  });

  it("serializes and parses inbox-event envelopes while falling back to chat for plain text", () => {
    expect(collaborationContextExample.schemaVersion).toBe(COLLABORATION_CONTEXT_SCHEMA_VERSION);
    expect(collaborationMessageEnvelopeExample.schemaVersion).toBe(COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION);

    const serialized = serializeCollaborationMessageEnvelope(collaborationMessageEnvelopeExample);
    const parsed = parseCollaborationMessageContent(serialized);
    expect(parsed.messageType).toBe("inbox_event");
    expect(parsed.plaintext).toBe(collaborationMessageEnvelopeExample.plaintext);
    expect(parsed.collaborationContext?.contextId).toBe(collaborationContextExample.contextId);
    expect(parsed.inboxEvent?.eventType).toBe("assignment");

    expect(parseCollaborationMessageContent("hello from a human operator")).toEqual({
      messageType: "chat",
      plaintext: "hello from a human operator",
      collaborationContext: null,
      inboxEvent: null,
    });
  });
});
