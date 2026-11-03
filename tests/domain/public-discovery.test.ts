import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { finalizeEvent, nip19 } from "nostr-tools";

import {
  buildPublicDiscoveryRelayDraft,
  parsePublicDiscoveryRelayEvent,
  publicAvailabilityHeartbeatExample,
  publicCapabilityAdvertisementExample,
  validatePublicDiscoveryEvent,
} from "../../src/protocol/public-discovery";
import { extractPublicDiscoveryObservations } from "../../src/runtime/trust-routing";

describe("public discovery domain contract", () => {
  it("round-trips a capability advertisement through relay serialization and parsing", () => {
    const privKey = schnorr.utils.randomPrivateKey();
    const draft = buildPublicDiscoveryRelayDraft(publicCapabilityAdvertisementExample);
    const event = finalizeEvent(draft, privKey);

    const parsed = parsePublicDiscoveryRelayEvent(event);
    expect(parsed).toBeTruthy();
    expect(parsed?.payload).toEqual(publicCapabilityAdvertisementExample);
    expect(parsed?.primaryId).toBe(publicCapabilityAdvertisementExample.advertisementId);
    expect(parsed?.dedupeKey).toContain(publicCapabilityAdvertisementExample.advertisementId);
  });

  it("validates event-specific payload requirements", () => {
    const errors = validatePublicDiscoveryEvent({
      ...publicAvailabilityHeartbeatExample,
      availabilityStatus: "maybe",
      presenceId: "",
    });

    expect(errors).toContain("presenceId is invalid");
    expect(errors).toContain(
      "availabilityStatus must be one of available, busy, draining, offline"
    );
  });

  it("rejects relay events whose tags drift from the typed payload", () => {
    const privKey = schnorr.utils.randomPrivateKey();
    const draft = buildPublicDiscoveryRelayDraft(publicAvailabilityHeartbeatExample);
    const tampered = finalizeEvent(
      {
        ...draft,
        tags: draft.tags.map((tag) => (tag[0] === "status" ? ["status", "busy"] : tag)),
      },
      privKey
    );

    expect(() => parsePublicDiscoveryRelayEvent(tampered)).toThrow(
      "relay event status tag must match availabilityStatus"
    );
  });

  it("rejects invalid signatures and ignores server assertions without a raw event", () => {
    const privKey = schnorr.utils.randomPrivateKey();
    const event = finalizeEvent(buildPublicDiscoveryRelayDraft(publicCapabilityAdvertisementExample), privKey);
    expect(extractPublicDiscoveryObservations({ items: [{ raw_event: { ...event, sig: "00".repeat(64) } }] })).toEqual([]);
    expect(extractPublicDiscoveryObservations({ items: [{
      author_npub: nip19.npubEncode(event.pubkey),
      primary_id: publicCapabilityAdvertisementExample.advertisementId,
      event_type: publicCapabilityAdvertisementExample.eventType,
      published_at: publicCapabilityAdvertisementExample.publishedAt,
      payload: publicCapabilityAdvertisementExample,
    }] })).toEqual([]);
  });

  it("derives routing identity and payload only from a locally verified raw event", () => {
    const privKey = schnorr.utils.randomPrivateKey();
    const event = finalizeEvent(buildPublicDiscoveryRelayDraft(publicCapabilityAdvertisementExample), privKey);
    const observations = extractPublicDiscoveryObservations({ items: [{
      author_npub: "npub1serverassertion",
      payload: { ...publicCapabilityAdvertisementExample, summary: "server changed this" },
      raw_event: event,
    }] });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.authorNpub).toBe(nip19.npubEncode(event.pubkey));
    expect(observations[0]?.payload).toEqual(publicCapabilityAdvertisementExample);
  });
});
