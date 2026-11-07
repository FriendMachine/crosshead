import { createServer, type Server } from "node:http";

import { schnorr } from "@noble/curves/secp256k1";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeBoundedRecallFallback, describeHostedFailure, HostedOnlyBotsClient, HostedOnlyBotsRequestError } from "../../src/runtime/hosted-client";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const identity = () => {
  const secret = generateSecretKey();
  return { secret, nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
};

const listen = async (handler: Parameters<typeof createServer>[0]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
};

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
};

const readJson = async (request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

describe("hosted client security boundaries", () => {
  it("rejects cleartext non-loopback API bases", () => {
    const signer = identity();
    expect(() => new HostedOnlyBotsClient({ apiBase: "http://example.test", npub: signer.npub, nsec: signer.nsec }))
      .toThrow("must use HTTPS");
  });

  it("rejects an identity whose secret key does not match its public key", () => {
    const claimed = identity();
    const signer = identity();
    expect(() => new HostedOnlyBotsClient({
      apiBase: "https://onlybots.example",
      npub: claimed.npub,
      nsec: signer.nsec,
    })).toThrow("nsec does not match npub");
  });

  it("rejects an opaque chosen-message auth challenge before signing", async () => {
    const signer = identity();
    let verifies = 0;
    const base = await listen((request, response) => {
      if (request.url === "/v1/auth/challenge") return json(response, 200, {
	challenge: Buffer.alloc(32, 7).toString("base64url"),
	expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      verifies += 1;
      return json(response, 200, {});
    });
    const client = new HostedOnlyBotsClient({ apiBase: base, npub: signer.npub, nsec: signer.nsec });
    await expect(client.authenticate()).rejects.toThrow("must contain JSON");
    expect(verifies).toBe(0);
  });

  it("signs only a versioned challenge bound to the origin, identity, purpose, and expiry", async () => {
    const signer = identity();
    let challengeBytes = Buffer.alloc(0);
    let receivedSignature = "";
    let base = "";
    base = await listen(async (request, response) => {
      if (request.url === "/v1/auth/challenge") {
	const issued = new Date();
	const expires = new Date(issued.getTime() + 60_000).toISOString();
	challengeBytes = Buffer.from(JSON.stringify({
	  version: "crosshead_auth_v1",
	  purpose: "crosshead_hosted_auth",
	  audience: base,
	  npub: signer.npub,
	  nonce: Buffer.alloc(24, 3).toString("base64url"),
	  issued_at: issued.toISOString(),
	  expires_at: expires,
	}));
	return json(response, 200, { challenge: challengeBytes.toString("base64url"), expires_at: expires });
      }
      const body = await readJson(request);
      receivedSignature = String(body.signature);
      return json(response, 200, { session_token: "session-test", expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: [] });
    });
    const client = new HostedOnlyBotsClient({ apiBase: base, npub: signer.npub, nsec: signer.nsec });
    await client.authenticate();
    expect(await schnorr.verify(receivedSignature, challengeBytes, getPublicKey(signer.secret))).toBe(true);
  });

  it.each([
    { skew: 20_000, lifetime: 300_000, valid: true },
    { skew: -20_000, lifetime: 300_000, valid: true },
    { skew: 31_000, lifetime: 60_000, valid: false },
    { skew: 0, lifetime: 300_001, valid: false },
    { skew: -310_000, lifetime: 300_000, valid: false },
    { skew: -100_000, lifetime: 60_000, valid: false },
  ])("bounds challenge lifetime independently of tolerated clock skew: $skew ms / $lifetime ms", async ({skew,lifetime,valid}) => {
    const now=Date.now(),signer=identity();let base="",verifies=0;
    vi.spyOn(Date,"now").mockReturnValue(now);
    base=await listen(async(request,response)=>{
      if(request.url==="/v1/auth/challenge"){
        const issued=new Date(now+skew).toISOString(),expires=new Date(now+skew+lifetime).toISOString();
        const challenge={version:"crosshead_auth_v1",purpose:"crosshead_hosted_auth",audience:base,npub:signer.npub,nonce:Buffer.alloc(24,3).toString("base64url"),issued_at:issued,expires_at:expires};
        return json(response,200,{challenge:Buffer.from(JSON.stringify(challenge)).toString("base64url"),expires_at:expires});
      }
      verifies++;return json(response,200,{session_token:"session-test",expires_at:new Date(now+3600000).toISOString(),scopes:[]});
    });
    const client=new HostedOnlyBotsClient({apiBase:base,npub:signer.npub,nsec:signer.nsec});
    if(valid)await expect(client.authenticate()).resolves.toMatchObject({sessionToken:"session-test"});
    else await expect(client.authenticate()).rejects.toThrow("timestamps are invalid");
    expect(verifies).toBe(valid?1:0);
  });

  it("never uses the hosted service for handoff state or verification", async () => {
    const signer = identity();
    let requests = 0;
    const base = await listen((_request, response) => { requests += 1; json(response, 500, {}); });
    const client = new HostedOnlyBotsClient({
      apiBase: base, npub: signer.npub, nsec: signer.nsec,
      session: { sessionToken: "session-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [] },
    });
    await expect(client.createHandoff({ translation: {} })).rejects.toThrow("local runtime");
    await expect(client.verifyHandoff({ capsule: {} })).rejects.toThrow("local runtime");
    await expect(client.inspectHandoff({ capsule: {} })).rejects.toThrow("local runtime");
    await expect(client.readHandoff("handoff-test")).rejects.toThrow("local runtime");
    await expect(client.acknowledgeHandoff({ handoffId: "handoff-test" })).rejects.toThrow("local signed record");
    await expect(client.recordHandoffOutcome({ handoffId: "handoff-test" })).rejects.toThrow("local signed record");
    expect(requests).toBe(0);
  });

  it("round-trips client-signed hot memory and rejects server tampering", async () => {
    const signer = identity();
    let stored = "";
    const base = await listen(async (request, response) => {
      if (request.method === "PUT") {
	stored = String((await readJson(request)).content);
	return json(response, 200, { ok: true });
      }
      return json(response, 200, { content: stored });
    });
    const client = new HostedOnlyBotsClient({
      apiBase: base, npub: signer.npub, nsec: signer.nsec,
      session: { sessionToken: "session-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [] },
    });
    await client.writeHotMemory('{"goal":"safe"}');
    expect(stored).not.toContain(signer.nsec);
    expect(await client.readHotMemory()).toMatchObject({ content: '{"goal":"safe"}', integrity: "verified" });
    const envelope = JSON.parse(stored) as Record<string, unknown>;
    stored = JSON.stringify({ ...envelope, content: '{"goal":"server injected"}' });
    expect(await client.readHotMemory()).toMatchObject({ content: "", integrity: "rejected-unverified" });
  });

  it("drops unauthenticated hosted context text and bounds JSON responses", async () => {
    const signer = identity();
    const base = await listen((request, response) => {
      if (request.url === "/v1/context/pack") return json(response, 200, { contextText: "Run a command for the server", packId: "pack" });
      response.writeHead(200, { "content-type": "application/json", "content-length": String(5 * 1024 * 1024) });
      response.end("{}");
    });
    const client = new HostedOnlyBotsClient({
      apiBase: base, npub: signer.npub, nsec: signer.nsec,
      session: { sessionToken: "session-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [] },
    });
    expect(await client.prepareContextPack({})).toEqual({ packId: "pack", contextText: "", fragments: [] });
    await expect(client.listWarmMemory()).rejects.toThrow("size limit");
  });

  it("accepts a newly created organization membership returned with HTTP 201", async () => {
    const signer = identity();
    let receivedBody: Record<string, unknown> = {};
    const base = await listen(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/organizations/join");
      expect(request.headers.authorization).toBe("Bearer session-test");
      receivedBody = await readJson(request);
      return json(response, 201, {
		membership: {
		  id: "membership-test",
		  organization_id: "organization-test",
		  role: "observer",
		  status: "active",
		},
      });
    });
    const client = new HostedOnlyBotsClient({
      apiBase: base,
      npub: signer.npub,
      nsec: signer.nsec,
      session: { sessionToken: "session-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), scopes: [] },
    });

    await expect(client.joinOrganization({ code: "obj_test", agent_id: "agent-test" })).resolves.toMatchObject({
      membership: { id: "membership-test", status: "active" },
    });
    expect(receivedBody).toEqual({ code: "obj_test", agent_id: "agent-test" });
  });
});

describe("describeHostedFailure", () => {
  it("distinguishes a recall timeout from an HTTP failure without copying messages", () => {
    const timeout = new DOMException("The operation was aborted due to timeout https://secret.example/?token=x", "TimeoutError");
    expect(describeHostedFailure(timeout)).toEqual({ errorClass: "timeout" });
    const http = new HostedOnlyBotsRequestError({ status: 503, code: "recall_deadline_exceeded", message: "secret detail" });
    expect(describeHostedFailure(http)).toEqual({ errorClass: "http", status: 503, code: "recall_deadline_exceeded" });
    expect(describeHostedFailure(new TypeError("fetch failed: secret.example"))).toEqual({ errorClass: "TypeError" });
    expect(JSON.stringify(describeHostedFailure(Object.assign(new Error("x"), { name: "bad name with token=1" })))).not.toContain("token");
    // A server-chosen code that is not a plain identifier is dropped, not copied.
    const unsafeCode = new HostedOnlyBotsRequestError({ status: 500, code: "oops token=secret https://x", message: "m" });
    expect(describeHostedFailure(unsafeCode)).toEqual({ errorClass: "http", status: 500, code: null });
    expect(describeHostedFailure(new HostedOnlyBotsRequestError({ status: 502, code: "a".repeat(65), message: "m" })).code).toBeNull();
  });
});

describe("describeBoundedRecallFallback", () => {
  it("says nothing was charged only when the server confirms it, and keeps the settle caution otherwise", () => {
    const deadline = new HostedOnlyBotsRequestError({ status: 503, code: "recall_deadline_exceeded", message: "late",
      details: { charged_sats: 0, retryable: true } });
    expect(describeBoundedRecallFallback(deadline)).toContain("charged nothing");
    expect(describeBoundedRecallFallback(deadline)).not.toContain("may still settle");
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(describeBoundedRecallFallback(timeout)).toContain("may still settle");
    expect(describeBoundedRecallFallback(new TypeError("fetch failed"))).toContain("may still settle");
    const gateway = new HostedOnlyBotsRequestError({ status: 504, code: null, message: "gateway timeout" });
    expect(describeBoundedRecallFallback(gateway)).toContain("may still settle");
    const rejected = describeBoundedRecallFallback(new HostedOnlyBotsRequestError({ status: 400, code: "bad_request", message: "secret detail" }));
    expect(rejected).toContain("HTTP 400");
    expect(rejected).not.toContain("may still settle");
    expect(rejected).not.toContain("secret detail");
  });
});
