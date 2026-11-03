import { Timestamped, Uuid } from "./base";

export type NostrTag = string[];

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
  sig: string;
};

export type RelayEvent = Timestamped & {
  id: Uuid;
  eventId: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: NostrTag[];
  sig: string;
  eventCreatedAt: Date;
};

export type RelayFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
} & Record<`#${string}`, string[] | undefined>;
