import { verifyEvent } from "nostr-tools";
import { parsePublicDiscoveryRelayEvent, type ParsedPublicDiscoveryRelayEvent } from "../protocol/public-discovery";
import type { NostrEvent } from "../protocol/relay";

// Resolve revisions before filtering by category, capability, status, or expiry.
// This prevents an older active ad from surviving a newer sold or expired revision.
// NIP-99 drafts (30403) have independent addresses; they do not retire a 30402 listing.
export const collectPublicDiscoveryEvents = (events: NostrEvent[], latestOnly = true): {
  items: ParsedPublicDiscoveryRelayEvent[]; rawEvents: NostrEvent[]; invalidSkipped: number;
} => {
  const items: ParsedPublicDiscoveryRelayEvent[] = [];
  const rawEvents: NostrEvent[] = [];
  const seen = new Set<string>();
  let invalidSkipped = 0;
  const verified: NostrEvent[] = [];
  for (const input of events) {
    try {
      // Fresh objects avoid nostr-tools' cached verification symbol.
      const event: NostrEvent = { id: input.id, pubkey: input.pubkey, kind: input.kind, created_at: input.created_at,
        tags: input.tags.map(tag => [...tag]), content: input.content, sig: input.sig };
      if (verifyEvent(event)) verified.push(event); else invalidSkipped++;
    } catch { invalidSkipped++; }
  }
  for (const event of verified.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))) {
    const key = `${event.kind}:${event.pubkey}:${event.tags.find(tag => tag[0] === "d")?.[1] ?? ""}`;
    if (latestOnly && seen.has(key)) continue;
    seen.add(key);
    rawEvents.push(event);
    try {
      const parsed = parsePublicDiscoveryRelayEvent(event);
      if (parsed) items.push(parsed);
    } catch { invalidSkipped++; }
  }
  return { items, rawEvents, invalidSkipped };
};


// Keep raw evidence across files and HTTP responses until all sources are merged.
export const publicDiscoveryRawEvents = (value: unknown): NostrEvent[] => {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.revision_events)) return record.revision_events as NostrEvent[];
  const rows = Array.isArray(value) ? value : Array.isArray(record.items) ? record.items
    : Array.isArray(record.publicDiscoveryItems) ? record.publicDiscoveryItems
      : Array.isArray(record.public_discovery_items) ? record.public_discovery_items : [value];
  return rows.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const raw = item.rawEvent ?? item.raw_event;
    return raw && typeof raw === "object" ? [raw as NostrEvent] : [];
  });
};
