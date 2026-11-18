import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const cliScript = path.resolve(__dirname, "../../dist/runtime/cli.js");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const json = (response: ServerResponse, status: number, body: unknown) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
};
const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};

type Fake = { base: string; joins: Array<{ npub: string; body: Record<string, unknown> }>; statusPolls: number; approveAfter: number; available: boolean; creatorNpub?: string; decision: "approved" | "denied"; badUrl: boolean; rejectJoins: boolean; failStatusOnce: boolean };

/** A hosted API that issues sessions per npub and implements the account link contract. */
const fakeService = async (): Promise<Fake> => {
  const fake: Fake = { base: "", joins: [], statusPolls: 0, approveAfter: 2, available: true, decision: "approved", badUrl: false, rejectJoins: false, failStatusOnce: false };
  const sessions = new Map<string, string>();
  let counter = 0;
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await readJson(request) : {};
    const url = request.url ?? "";
    if (url === "/v1/auth/challenge") {
      const issued = new Date().toISOString(), expires = new Date(Date.now() + 120_000).toISOString();
      const challenge = { version: "crosshead_auth_v1", purpose: "crosshead_hosted_auth", audience: fake.base, npub: body.npub, nonce: Buffer.alloc(24, 3).toString("base64url"), issued_at: issued, expires_at: expires };
      return json(response, 200, { challenge: Buffer.from(JSON.stringify(challenge)).toString("base64url"), expires_at: expires });
    }
    if (url === "/v1/auth/verify") {
      const token = `session-${counter += 1}`;
      sessions.set(token, String(body.npub));
      return json(response, 200, { session_token: token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), scopes: ["billing:*"] });
    }
    const caller = sessions.get(String(request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!fake.available && url.startsWith("/v1/account-links")) return json(response, 404, { error: { code: "not_available", message: "Not available" } });
    if (url === "/v1/account-links") {
      if (!caller) return json(response, 401, { error: { code: "unauthorized", message: "no session" } });
      fake.creatorNpub = caller;
      fake.joins.push({ npub: caller, body });
      return json(response, 201, {
        request_id: "11111111-2222-4333-8444-555555555555", user_code: "BCDF-GHJK", poll_secret: "xhlp_secret",
        verification_url: fake.badUrl ? "https://evil.example/account/link?code=BCDF-GHJK&calc.exe" : `${fake.base}/account/link?code=BCDF-GHJK`, verification_url_base: `${fake.base}/account/link`,
        expires_at: new Date(Date.now() + 600_000).toISOString(), interval_seconds: 0,
      });
    }
    if (url === "/v1/account-links/11111111-2222-4333-8444-555555555555/agents") {
      if (!caller) return json(response, 401, { error: { code: "unauthorized", message: "no session" } });
      if (body.poll_secret !== "xhlp_secret" || fake.rejectJoins) return json(response, 404, { error: { code: "not_found", message: "Not found" } });
      fake.joins.push({ npub: caller, body });
      return json(response, 200, { request_id: "11111111-2222-4333-8444-555555555555", agent_count: fake.joins.length });
    }
    if (url === "/v1/account-links/11111111-2222-4333-8444-555555555555/status") {
      if (body.poll_secret !== "xhlp_secret" || request.headers.authorization) return json(response, 404, { error: { code: "not_found", message: "Not found" } });
      fake.statusPolls += 1;
      if (fake.failStatusOnce) { fake.failStatusOnce = false; return json(response, 503, { error: { code: "unavailable", message: "try later" } }); }
      if (fake.decision === "denied" && fake.statusPolls >= fake.approveAfter) {
        return json(response, 200, { request_id: "11111111-2222-4333-8444-555555555555", status: "denied", expires_at: new Date(Date.now() + 600_000).toISOString(), account: null, organization: null, agents: [] });
      }
      const approved = fake.statusPolls >= fake.approveAfter;
      return json(response, 200, {
        request_id: "11111111-2222-4333-8444-555555555555", status: approved ? "approved" : "pending", expires_at: new Date(Date.now() + 600_000).toISOString(),
        account: approved ? { display_name: "Pat", email: "pat@example.test" } : null,
        organization: approved ? { id: "org_1", name: "Example Org" } : null,
        agents: approved ? fake.joins.map(({ npub, body: joined }, index) => ({
          npub, agent_id: joined.agent_id ?? null, linked: true,
          organization: index === 0 ? "attached" : "failed", funding_source: index === 0 ? "organization" : null,
          error: index === 0 ? null : "That agent already belongs to another organization. Detach it there first.",
        })) : [],
      });
    }
    return json(response, 404, { error: { code: "not_found", message: `unexpected ${url}` } });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  fake.base = `http://127.0.0.1:${address.port}`;
  return fake;
};

const runCli = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, [cliScript, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

it("links several local agents through one approval, each proving its own key", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "crosshead-account-link-")));
  const home = path.join(root, "runtime");
  const env = { PATH: process.env.PATH, HOME: root, CROSSHEAD_HOOK_AUTOSTART: "0", CROSSHEAD_ACCOUNT_LINK_MIN_INTERVAL_MS: "50" };
  const fake = await fakeService();
  try {
    for (const [name, extra] of [["alpha", []], ["beta", ["--no-default"]], ["offline", ["--no-default"]]] as const) {
      const made = spawnSync(process.execPath, [cliScript, "keygen", "--setup", "--profile", name, "--api-base", "http://127.0.0.1:0", ...extra, "--home", home], { env, encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
    }
    // Point two profiles at the hosted fake; the third stays local-only.
    for (const name of ["alpha", "beta"]) {
      const file = path.join(home, "config/profiles", `${name}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), apiBase: fake.base, agentId: `agent_${name}` }));
    }
    const npubOf = (name: string) => JSON.parse(readFileSync(path.join(home, "config/profiles", `${name}.json`), "utf8")).npub as string;

    const result = await runCli(["account", "link", "--all-profiles", "--no-browser", "--json", "--home", home], env);
    expect(result.status, result.stderr).toBe(3); // approved, but beta couldn't join the organization
    expect(result.stdout + result.stderr).not.toContain("xhlp_secret");
    const intro = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    expect(intro).toMatchObject({ status: "pending", user_code: "BCDF-GHJK", verification_url: `${fake.base}/account/link?code=BCDF-GHJK`, profiles: ["alpha", "beta"], browser_opened: false });
    const final = JSON.parse(result.stdout);
    expect(final.status).toBe("approved");
    expect(final.organization).toEqual({ id: "org_1", name: "Example Org" });
    expect(final.skipped).toEqual([{ profile: "offline", reason: "local-only profile with no hosted account" }]);
    // The creator and the joining profile each authenticated as themselves.
    expect(fake.creatorNpub).toBe(npubOf("alpha"));
    expect(fake.joins.map((entry) => entry.npub)).toEqual([npubOf("alpha"), npubOf("beta")]);
    expect(fake.joins[0]!.body).toMatchObject({ agent_id: "agent_alpha", display_name: "alpha" });
    expect(fake.joins[1]!.body).toMatchObject({ poll_secret: "xhlp_secret", agent_id: "agent_beta" });
    expect(readdirSync(path.join(home, "state/account-links"))).toEqual([]);

    // Text output names the account, organization and each agent's outcome.
    fake.joins.length = 0; fake.statusPolls = 0;
    const text = await runCli(["account", "link", "--profiles", "alpha,beta", "--no-browser", "--home", home], env);
    expect(text.status, text.stderr).toBe(3);
    expect(text.stderr).toContain("crosshead account link --resume 11111111-2222-4333-8444-555555555555");
    expect(text.stderr).toContain("enter code BCDF-GHJK");
    expect(text.stdout).toContain("Linked to pat@example.test in Example Org.");
    expect(text.stdout).toContain("agent_alpha: linked; added to the organization, paid from organization credits");
    expect(text.stdout).toContain("agent_beta: linked; not added to the organization: That agent already belongs to another organization.");

    // Agents can start without blocking, then resume.
    fake.joins.length = 0; fake.statusPolls = 0; fake.approveAfter = 1;
    const started = await runCli(["account", "link", "--profile", "alpha", "--no-browser", "--no-wait", "--json", "--home", home], env);
    expect(started.status, started.stderr).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ status: "pending", resume_command: "crosshead account link --resume 11111111-2222-4333-8444-555555555555" });
    expect(fake.statusPolls).toBe(0);
    const saved = path.join(home, "state/account-links/11111111-2222-4333-8444-555555555555.json");
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    fake.failStatusOnce = true; // a transient error while polling is retried
    const resumed = await runCli(["account", "link", "--resume", "11111111-2222-4333-8444-555555555555", "--json", "--home", home], env);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).status).toBe("approved");
    expect(existsSync(saved)).toBe(false);

    // A denial exits 1; an untrusted approval URL is never used, and a rejected join skips only that profile.
    fake.joins.length = 0; fake.statusPolls = 0; fake.decision = "denied"; fake.badUrl = true; fake.rejectJoins = true;
    const denied = await runCli(["account", "link", "--profiles", "alpha,beta", "--no-browser", "--json", "--home", home], env);
    expect(denied.status, denied.stderr).toBe(1);
    const deniedIntro = JSON.parse(denied.stderr.trim().split("\n").at(-1)!);
    expect(deniedIntro.verification_url).toBe(`${fake.base}/account/link`);
    expect(deniedIntro.profiles).toEqual(["alpha"]);
    expect(deniedIntro.skipped).toEqual([{ profile: "beta", reason: "the request was not found or its secret was rejected" }]);
    expect(JSON.parse(denied.stdout).status).toBe("denied");
    fake.decision = "approved"; fake.badUrl = false; fake.rejectJoins = false;

    // Flags without values are errors, not silent defaults.
    const bare = await runCli(["account", "link", "--resume", "--home", home], env);
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain("--resume needs a value");

    // A service without the feature gets a pointer to the console instead.
    fake.available = false;
    const old = await runCli(["account", "link", "--profile", "alpha", "--no-browser", "--home", home], env);
    expect(old.status).not.toBe(0);
    expect(old.stderr).toContain(`doesn't support linking from the CLI yet. Link agents in the console instead: ${fake.base}/account/settings`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
