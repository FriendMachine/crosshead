import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keygenFromCli } from "../../src/runtime/cli/core";
import { setupRuntimeProfile } from "../../src/runtime/local-runtime";
import { loadProfile, loadSecret, resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

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
// What Node's fetch throws when there is no route to the host.
const unreachable = () => vi.fn().mockRejectedValue(new TypeError("fetch failed"));

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
});
