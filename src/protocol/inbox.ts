import { Npub, Timestamped, Uuid } from "./base";
import type {
  CollaborationContextMetadata,
  CollaborationEventPriority,
  CollaborationMessageType,
  TypedInboxEvent,
} from "./collaboration";

export const DURABLE_INBOX_STATUSES = [
  "unread",
  "acknowledged",
  "completed",
  "failed",
  "rejected",
  "dead_letter",
] as const;
export const DURABLE_INBOX_TERMINAL_STATUSES = ["completed", "failed", "rejected", "dead_letter"] as const;
export const DURABLE_INBOX_HISTORY_KINDS = [
  "created",
  "replayed",
  "acknowledged",
  "completed",
  "failed",
  "rejected",
  "return_path_sent",
  "dead_letter",
] as const;

export type DurableInboxStatus = (typeof DURABLE_INBOX_STATUSES)[number];
export type DurableInboxTerminalStatus = (typeof DURABLE_INBOX_TERMINAL_STATUSES)[number];
export type DurableInboxHistoryKind = (typeof DURABLE_INBOX_HISTORY_KINDS)[number];

export type DurableInboxHistoryEntry = {
  kind: DurableInboxHistoryKind;
  at: Date;
  actorNpub: Npub | null;
  note: string | null;
  relatedEventId: string | null;
};

export type DurableInboxItem = Timestamped & {
  id: Uuid;
  recipientNpub: Npub;
  senderNpub: Npub;
  messageEventId: string;
  messageType: CollaborationMessageType;
  contextId: string | null;
  taskRef: string | null;
  priority: CollaborationEventPriority | null;
  status: DurableInboxStatus;
  plaintext: string;
  collaborationContext: CollaborationContextMetadata | null;
  inboxEvent: TypedInboxEvent | null;
  ackedAt: Date | null;
  terminalAt: Date | null;
  lastReplayedAt: Date | null;
  replayCount: number;
  lastDeadLetterReason: string | null;
  returnPathLastEventId: string | null;
  history: DurableInboxHistoryEntry[];
};

export const isDurableInboxTerminalStatus = (status: DurableInboxStatus): status is DurableInboxTerminalStatus =>
  DURABLE_INBOX_TERMINAL_STATUSES.includes(status as DurableInboxTerminalStatus);
