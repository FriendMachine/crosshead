import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keygenFromCli } from "../../src/runtime/cli/core";
import { HostedOnlyBotsRequestError } from "../../src/runtime/hosted-client";
import { describeFetchFailure, hostedServiceUnreachableReason, setupRuntimeProfile } from "../../src/runtime/local-runtime";
import { loadProfile, loadSecret, resolveRuntimePaths } from "../../src/runtime/runtime-persistence";
import { buildRuntimeDoctorDirect } from "../../src/runtime/runtime-status";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }));
});

const newHome = (): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-offline-setup-"));
  homes.push(home);
  return home;
};
const identity = () => {
  const secret = generateSecretKey();
  return { nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
};
// What Node's fetch throws when the connection is refused: the reason is in `cause`.
const unreachable = () => vi.fn().mockRejectedValue(
  new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) })
);

describe("setup when the hosted service cannot be reached", () => {
  it("creates the profile and defers sign-in", async () => {
    const home = newHome();
    const key = identity();
    const fetchMock = unreachable();
    vi.stubGlobal("fetch", fetchMock);

    const profile = await setupRuntimeProfile({ home, profileName: "default", apiBase: "https://crosshead.sh", ...key, makeDefault: true });

    expect(fetchMock).toHaveBeenCalled();
    expect(profile.registrationDeferred).toBe(true);
    const paths = resolveRuntimePaths(home);
    const saved = loadProfile(paths, "default");
    expect(saved).toMatchObject({ npub: key.npub, apiBase: "https://crosshead.sh" });
    // The flag describes this run; it is not part of the stored profile.
    expect(saved).not.toHaveProperty("registrationDeferred");
    expect(loadSecret(paths, "default")).toMatchObject({ nsec: key.nsec, session: null });
  });

  it("tells the operator in the keygen output", async () => {
    const home = newHome();
    vi.stubGlobal("fetch", unreachable());
    const text = await keygenFromCli(["--setup", "--home", home, "--profile", "default", "--api-base", "https://crosshead.sh"]);
    expect(text).toContain("registration: deferred");
    const json = JSON.parse(await keygenFromCli(["--setup", "--home", newHome(), "--profile", "default", "--api-base", "https://crosshead.sh", "--json"]));
    expect(json.registrationDeferred).toBe(true);
  });

  it("still fails when the service answers and refuses the sign-in", async () => {
    const home = newHome();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "forbidden", message: "registration closed" } }),
      { status: 403, headers: { "content-type": "application/json" } }
    )));
    await expect(setupRuntimeProfile({ home, profileName: "default", apiBase: "https://crosshead.sh", ...identity(), makeDefault: true }))
      .rejects.toThrow();
    expect(existsSync(path.join(home, "config", "profiles", "default.json"))).toBe(false);
    expect(loadProfile(resolveRuntimePaths(home), "default")).toBeNull();
  });

  it("does not report a deferral for a local-only profile", async () => {
    const fetchMock = unreachable();
    vi.stubGlobal("fetch", fetchMock);
    const profile = await setupRuntimeProfile({ home: newHome(), profileName: "default", apiBase: "http://127.0.0.1:0", ...identity(), makeDefault: true });
    expect(profile.registrationDeferred).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails instead of deferring when the address is wrong rather than unreachable", async () => {
    const typo = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND crossheed.sh"), { code: "ENOTFOUND" }) });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(typo));
    const home = newHome();
    await expect(setupRuntimeProfile({ home, profileName: "default", apiBase: "https://crossheed.sh", ...identity(), makeDefault: true }))
      .rejects.toThrow("Could not sign in to https://crossheed.sh: ENOTFOUND: getaddrinfo ENOTFOUND crossheed.sh. Check --api-base.");
    expect(loadProfile(resolveRuntimePaths(home), "default")).toBeNull();
  });
});

describe("doctor after a deferred setup", () => {
  it("says the profile has never signed in, and why the sign-in failed", async () => {
    const home = newHome();
    vi.stubGlobal("fetch", unreachable());
    await setupRuntimeProfile({ home, profileName: "default", apiBase: "https://crosshead.sh", ...identity(), makeDefault: true });
    // The service is reachable now but refuses the registration. A fresh Response per call: doctor pings first.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: "forbidden", message: "registration closed" } }),
      { status: 403, headers: { "content-type": "application/json" } }
    )));
    const auth = (await buildRuntimeDoctorDirect(home, "default")).checks.find((check) => check.id === "auth");
    expect(auth?.ok).toBe(false);
    expect(auth?.message).toContain("has not signed in to https://crosshead.sh yet");
    expect(auth?.message).toContain("registration closed");
  });
});

describe("doctor on a local-only profile", () => {
  it("does not report a missing sign-in", async () => {
    const home = newHome();
    const fetchMock = unreachable();
    vi.stubGlobal("fetch", fetchMock);
    await setupRuntimeProfile({ home, profileName: "default", apiBase: "http://127.0.0.1:0", ...identity(), makeDefault: true });
    const checks = (await buildRuntimeDoctorDirect(home, "default")).checks;
    expect(checks.find((check) => check.id === "auth")).toMatchObject({ ok: true, message: expect.stringContaining("Local-only") });
    expect(checks.find((check) => check.id === "api_base")?.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("classifying hosted sign-in failures", () => {
  const failed = (cause: unknown) => new TypeError("fetch failed", { cause });
  const coded = (code: string) => Object.assign(new Error(code), { code });

  it("defers only for failures that mean no route to the service", () => {
    expect(hostedServiceUnreachableReason(failed(coded("ECONNREFUSED")), "https://api.example.test")).toBe("ECONNREFUSED");
    expect(hostedServiceUnreachableReason(failed(new AggregateError([coded("ENETUNREACH"), coded("EHOSTUNREACH")])), "https://crosshead.sh")).toBe("ENETUNREACH");
    expect(hostedServiceUnreachableReason(failed(coded("UND_ERR_CONNECT_TIMEOUT")), "https://crosshead.sh")).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(hostedServiceUnreachableReason(Object.assign(new Error("timed out"), { name: "TimeoutError" }), "https://crosshead.sh")).toBe("timed out");
    // DNS failing for the default service means DNS is unavailable; for any other host it is more likely a typo.
    expect(hostedServiceUnreachableReason(failed(coded("ENOTFOUND")), "https://crosshead.sh")).toBe("ENOTFOUND");
    expect(hostedServiceUnreachableReason(failed(coded("ENOTFOUND")), "https://crossheed.sh")).toBeNull();
    // An allowlisting egress proxy refusing the tunnel, exactly as Node 26 reports it.
    const proxyRefusal = failed(Object.assign(new Error("Request was cancelled."), {
      cause: Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { code: "UND_ERR_ABORTED" }),
    }));
    expect(hostedServiceUnreachableReason(proxyRefusal, "https://crosshead.sh")).toBe("proxy refused the connection (HTTP 403)");
  });

  it("names the underlying cause of a fetch failure", () => {
    expect(describeFetchFailure(failed(coded("CERT_HAS_EXPIRED")))).toBe("CERT_HAS_EXPIRED: CERT_HAS_EXPIRED");
    expect(describeFetchFailure(failed(new Error("unexpected redirect")))).toBe("unexpected redirect");
    expect(describeFetchFailure(failed(undefined))).toBe("fetch failed");
  });

  it("reports redirects, certificate errors, HTTP answers and unexplained failures", () => {
    expect(hostedServiceUnreachableReason(failed(new Error("unexpected redirect")), "https://crosshead.sh")).toBeNull();
    expect(hostedServiceUnreachableReason(failed(coded("CERT_HAS_EXPIRED")), "https://crosshead.sh")).toBeNull();
    expect(hostedServiceUnreachableReason(failed(coded("ERR_TLS_CERT_ALTNAME_INVALID")), "https://crosshead.sh")).toBeNull();
    expect(hostedServiceUnreachableReason(failed(undefined), "https://crosshead.sh")).toBeNull();
    expect(hostedServiceUnreachableReason(new HostedOnlyBotsRequestError({ message: "nope", status: 503 }), "https://crosshead.sh")).toBeNull();
    expect(hostedServiceUnreachableReason(new Error("Invalid challenge"), "https://crosshead.sh")).toBeNull();
  });
});

describe("guided project setup with no connection", () => {
  const cliScript = path.resolve(__dirname, "../../dist/runtime/cli.js");

  // A port that was free a moment ago, so a connection to it is refused. (Fetch blocks low ports
  // such as 1 outright with "bad port", which is rightly not treated as offline.)
  const closedPort = () => new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

  it("reports the deferred sign-in instead of only 'setup complete', using Node's real refused-connection error", async () => {
    const apiBase = `http://127.0.0.1:${await closedPort()}`;
    const root = realpathSync(newHome());
    const home = path.join(root, "runtime");
    const project = path.join(root, "project");
    mkdirSync(project, { recursive: true });
    expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
    mkdirSync(path.join(root, "codex"), { recursive: true });
    mkdirSync(path.join(root, "claude"), { recursive: true });
    // Nothing listens on port 1, so the connection is refused immediately.
    const run = spawnSync(process.execPath, [
      cliScript, "quickstart", "--scope", "project", "--adapter", "both", "--workspace-root", project, "--profile", "work",
      "--api-base", apiBase, "--no-start", "--codex-home", path.join(root, "codex"), "--claude-home", path.join(root, "claude"),
      "--home", home,
    ], { env: { PATH: process.env.PATH, CROSSHEAD_HOOK_AUTOSTART: "0" }, encoding: "utf8", timeout: 20000 });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(run.stdout).toContain("Crosshead setup complete.");
    expect(run.stdout).toContain("work registration: deferred");
    expect(run.stdout).toContain("ECONNREFUSED");
    expect(loadProfile(resolveRuntimePaths(home), "work")).toMatchObject({ apiBase });
  }, 30_000);
});
