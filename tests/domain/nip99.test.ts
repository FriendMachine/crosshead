import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trustFromCli } from "../../src/runtime/trust-routing-cli";
import { publicDiscoveryRawEvents } from "../../src/runtime/public-discovery";
import { collectPublicDiscoveryEvents } from "../../src/runtime/public-discovery";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { finalizeEvent } from "nostr-tools";
import {
  buildPublicDiscoveryRelayDraft, isPublicDiscoveryActive,
  parsePublicDiscoveryRelayEvent, publicCapabilityAdvertisementExample as advertisement,
  publicTaskOfferExample as offer, publicDiscoveryEventExamples, publicDiscoveryKinds,
} from "../../src/protocol/public-discovery";
import { extractPublicDiscoveryObservations, inspectTrustGraph } from "../../src/runtime/trust-routing";
import type { NostrEvent } from "../../src/protocol/relay";

const key = schnorr.utils.randomPrivateKey();
const external = (overrides: Partial<Parameters<typeof finalizeEvent>[0]> = {}, signingKey = key): NostrEvent => finalizeEvent({
  kind: 30402, created_at: 1793930000,
  tags: [["d", "services/安全 review"], ["title", "Security review"], ["price", "5.00", "USD", "hour"]],
  content: "## Security review\nI review code.\n", ...overrides,
}, signingKey);

describe("NIP-99 interoperability", () => {
  it.each(publicDiscoveryEventExamples)("round-trips $eventType", payload => {
    expect(parsePublicDiscoveryRelayEvent(finalizeEvent(buildPublicDiscoveryRelayDraft(payload), key))?.payload).toEqual(payload);
  });
  it("writes Markdown and standard tags without a Crosshead JSON envelope", () => {
    const event = buildPublicDiscoveryRelayDraft(advertisement);
    expect(event.kind).toBe(30402);
    expect(event.content).toBe(advertisement.description);
    expect(event.tags).toContainEqual(["price", "0.00001200", "BTC", "hour"]);
    expect(event.tags).toContainEqual(["title", advertisement.title]);
    expect(event.tags).toContainEqual(["published_at", "1776864600"]);
    expect(event.tags.some(tag => tag[0] === "x")).toBe(false);
  });
  it("reads third-party listings with arbitrary identifiers and no Crosshead tags", () => {
    const parsed = parsePublicDiscoveryRelayEvent(external())!;
    expect(parsed.primaryId).toBe("services/安全 review");
    expect(parsed.payload.eventType).toBe("capability_advertisement");
    expect("price" in parsed.payload && parsed.payload.price).toEqual({ amount: "5.00", currency: "USD", frequency: "hour" });
    expect(parsed.payload.agentId).toBeNull();
  });
  it("accepts listings without optional recommended metadata", () => {
    const parsed = parsePublicDiscoveryRelayEvent(external({ tags: [], content: "A service" }))!;
    expect(parsed.primaryId).toBe("");
    expect("price" in parsed.payload && parsed.payload.price).toBeNull();
  });
  it("does not interpret third-party extension tags as Crosshead capabilities", () => {
    const parsed = parsePublicDiscoveryRelayEvent(external({ tags: [["c", "arbitrary category"], ["trust", "not-a-crosshead-zone"]] }))!;
    expect(parsed.payload.eventType === "capability_advertisement" && parsed.payload.capabilityIds).toEqual([]);
  });
  it("classifies work opportunities by the jobs category", () => {
    const parsed = parsePublicDiscoveryRelayEvent(external({ tags: [["d", "writing"], ["t", "jobs"]] }))!;
    expect(parsed.payload.eventType).toBe("task_offer");
  });
  it("preserves exact decimal amounts without converting bitcoin to sats", () => {
    const parsed = parsePublicDiscoveryRelayEvent(external({ tags: [["price", "12345678901234567890.00000001", "btc"]] }))!;
    expect("price" in parsed.payload && parsed.payload.price?.amount).toBe("12345678901234567890.00000001");
  });
  it.each(["-1", "NaN", "Infinity", "1e5", "", " 5", "1.2.3"])("rejects malformed price %j", amount => {
    expect(() => parsePublicDiscoveryRelayEvent(external({ tags: [["price", amount, "USD"]] }))).toThrow("price");
  });
  it("rejects missing price currency", () => {
    expect(() => parsePublicDiscoveryRelayEvent(external({ tags: [["price", "5"]] }))).toThrow("price");
  });
  it("preserves original publication time across a later revision", () => {
    const event = finalizeEvent(buildPublicDiscoveryRelayDraft({ ...advertisement, updatedAt: "2026-04-23T13:30:00.000Z" }), key);
    const parsed = parsePublicDiscoveryRelayEvent(event)!;
    expect(parsed.payload.publishedAt).toBe(advertisement.publishedAt);
    expect("updatedAt" in parsed.payload && parsed.payload.updatedAt).toBe("2026-04-23T13:30:00.000Z");
  });
  it.each(["bad", "-1", "999999999999999999999"])("rejects malformed timestamp %s", timestamp => {
    expect(() => parsePublicDiscoveryRelayEvent(external({ tags: [["published_at", timestamp]] }))).toThrow("timestamp");
  });
  it("uses standard expiration seconds and treats the boundary as expired", () => {
    const payload = { ...offer, expiresAt: "2026-04-22T15:00:00.000Z" };
    const event = buildPublicDiscoveryRelayDraft(payload);
    expect(event.tags).toContainEqual(["expiration", "1776870000"]);
    expect(isPublicDiscoveryActive(payload, Date.parse(payload.expiresAt))).toBe(false);
    expect(isPublicDiscoveryActive(payload, Date.parse(payload.expiresAt) - 1)).toBe(true);
  });
  it("writes draft/inactive listings as kind 30403", () => {
    const payload = { ...advertisement, listingStatus: "inactive" as const };
    expect(buildPublicDiscoveryRelayDraft(payload).kind).toBe(30403);
    expect(isPublicDiscoveryActive(payload)).toBe(false);
  });
  it.each([31410, 31412])("does not read removed custom listing kind %s", kind => {
    expect(parsePublicDiscoveryRelayEvent(external({ kind, content: JSON.stringify(advertisement) }))).toBeNull();
  });
  it("queries both listing kinds, even when one category is requested", () => {
    expect(publicDiscoveryKinds(["capability_advertisement"])).toEqual([30402, 30403]);
    expect(publicDiscoveryKinds()).toEqual([30402, 30403, 31411, 31413]);
  });
});

describe("listing revision and routing boundaries", () => {
  it("keeps draft and published addresses independent, as NIP-01 requires", () => {
    const active = external();
    const inactive = external({ kind: 30403, created_at: active.created_at + 1 });
    expect(collectPublicDiscoveryEvents([active, inactive]).items.map(item => item.relayEvent.id)).toEqual([inactive.id, active.id]);
  });
  it("does not resurrect an active revision behind a signed malformed revision", () => {
    const active = external();
    const invalid = external({ created_at: active.created_at + 1, tags: [...active.tags, ["status", "unknown"]] });
    expect(collectPublicDiscoveryEvents([active, invalid])).toMatchObject({ items: [], invalidSkipped: 1, rawEvents: [invalid] });
  });
  it("ignores forged revisions and cached verification mutations", () => {
    const active = external();
    const forged = { ...external({ created_at: active.created_at + 1 }), sig: "00".repeat(64) };
    const cached = external({ created_at: active.created_at + 2 });
    cached.content = "changed after signing";
    expect(collectPublicDiscoveryEvents([active, forged, cached]).items.map(item => item.relayEvent.id)).toEqual([active.id]);
  });
  it("contains malformed untrusted raw objects instead of throwing", () => {
    expect(extractPublicDiscoveryObservations([{ raw_event: { id: 7 } }, { raw_event: { id: null } }])).toEqual([]);
  });
  it("resolves timestamp ties using the lowest event id, independent of input order", () => {
    const a = external({ content: "A" }), b = external({ content: "B" });
    const expected = [a.id, b.id].sort()[0];
    expect(collectPublicDiscoveryEvents([a, b]).items[0]?.relayEvent.id).toBe(expected);
    expect(collectPublicDiscoveryEvents([b, a]).items[0]?.relayEvent.id).toBe(expected);
  });
  it("resolves signed raw revisions globally across separate offline input files", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "x99-files-"));
    try {
      const active = finalizeEvent(buildPublicDiscoveryRelayDraft(advertisement), key);
      const invalid = external({ created_at: active.created_at + 1,
        tags: [["d", advertisement.advertisementId], ["price", "invalid", "BTC"]] });
      const oldFile = path.join(home, "old.json"), newFile = path.join(home, "new.json");
      writeFileSync(oldFile, JSON.stringify({ items: [{ raw_event: active }] }));
      writeFileSync(newFile, JSON.stringify({ revision_events: [invalid] }));
      const result = JSON.parse(await trustFromCli(["graph", "--home", home, "--event-files", `${oldFile},${newFile}`, "--fetch-public", "false", "--json"]));
      expect(result.capabilityClaims).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("preserves rejected signed evidence when merging an HTTP response with older offline data", () => {
    const active = external();
    const invalid = external({ created_at: active.created_at + 1, tags: [...active.tags.filter(tag => tag[0] !== "price"), ["price", "bad", "BTC"]] });
    const response = { items: [], revision_events: collectPublicDiscoveryEvents([invalid]).rawEvents };
    expect(extractPublicDiscoveryObservations({ revision_events: [active, ...publicDiscoveryRawEvents(response)] })).toEqual([]);
  });
  it("never derives active capability claims from an independent draft", async () => {
    const draft = finalizeEvent(buildPublicDiscoveryRelayDraft({ ...advertisement, listingStatus: "inactive" }), key);
    const graph = await inspectTrustGraph({ publicDiscoveryItems: extractPublicDiscoveryObservations([{ raw_event: draft }]) });
    expect(graph.capabilityClaims).toEqual([]);
  });
  it("does not merge different authors' identifiers", () => {
    expect(collectPublicDiscoveryEvents([external(), external({}, schnorr.utils.randomPrivateKey())]).items).toHaveLength(2);
  });
  it.each(["sold", "expired"])("does not route an offline %s listing or its older active revision", async state => {
    const active = finalizeEvent(buildPublicDiscoveryRelayDraft(advertisement), key);
    const changed = { ...advertisement, updatedAt: "2026-04-23T00:00:00.000Z",
      listingStatus: state === "expired" ? "active" as const : state as "sold" | "inactive",
      expiresAt: state === "expired" ? "2026-04-23T01:00:00.000Z" : null };
    const revision = finalizeEvent(buildPublicDiscoveryRelayDraft(changed), key);
    const observations = extractPublicDiscoveryObservations([{ raw_event: active }, { raw_event: revision }]);
    expect(observations).toHaveLength(1);
    const graph = await inspectTrustGraph({ publicDiscoveryItems: observations, now: () => new Date("2026-04-24T00:00:00Z") });
    expect(graph.capabilityClaims).toEqual([]);
  });
});
