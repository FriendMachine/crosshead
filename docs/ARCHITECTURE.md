# Architecture and compatibility

## Boundary

This repository is the client. The hosted service (API, billing, recall
selection, storage, operator tooling) lives in a separate private repository
and consumes this one as a pinned release.

```text
crosshead (this repo)                     hosted service repo
  src/protocol  ──── @crosshead/protocol ──▶ API shapes, validators, schemas
  src/runtime   ──── @crosshead/runtime  ──▶ embedded runtime (hosted Pi
                                             controller) and operator builds
  release/      ──── install tarball ─────▶ served unchanged at /install
```

Rules, enforced by `npm run check:boundary` and `scripts/verify-release.mjs`:

- `src/protocol` imports only other protocol modules and Node built-ins.
- `src/runtime` imports only runtime/protocol modules, Node built-ins and the
  dependencies in `package.json`.
- The install tarball contains only `package.json`, `package-lock.json` and
  compiled JavaScript under `dist/runtime` and `dist/protocol`. Verification
  scans it for hosted-service imports and credential patterns and checks the
  runtime dependency allowlist.

Code that only the hosted service needs, such as recall heuristics, does not
belong here. Code both sides need lives here; the hosted service imports it.

The Claude Code and Codex plugins (`plugins/`, `.claude-plugin/`,
`.agents/plugins/`) are generated from `src/runtime/host-hook-spec.ts` and are
installed from this repository by the hosts, not from the release tarball. They
only run the installed runtime's hook entrypoints; see
[HOST-PLUGINS.md](HOST-PLUGINS.md).

## Operator extensions

FriendMachine's local operator runs a superset build from the hosted
repository. The client exposes two seams for it:

- `runOnlyBotsDaemonCli(argv, { composeOrganizationalWorker })` in
  `src/runtime/daemon-host.ts`. The public daemon has no composer and rejects
  `--organizational-worker-config`.
- `runOnlyBotsCtlCli(argv, { commands, cliScriptPath, daemonScriptPath })` in
  `src/runtime/cli.ts`. Operator builds add commands (for example
  `continuity benchmark`) and point managed restarts at their own entries.

The organizational-worker daemon API types and the federation-status wire
contract stay in this repository because the daemon serves them; the
implementations (Baseplate clients, worker controller and store) do not.

## Staying in sync with the hosted service

1. **Shared definitions compile on both sides.** The hosted service imports
   protocol types, validators and constants from `@crosshead/runtime`
   (`dist/protocol/*`) instead of keeping its own copies. A change here that
   breaks the server fails the server's typecheck when it updates the pin.
2. **Contract tests run against the exact artifact.** The hosted repository's
   adapter, CLI, update and recall suites start the real server in-process and
   drive this runtime from the vendored package, not from source.
3. **The served tarball is the released tarball.** The hosted service serves
   the vendored install tarball byte-for-byte; its digest must match the
   release manifest. It does not rebuild the client.
4. **Schemas have one owner.** `schemas/` is canonical. The hosted repository's
   documentation copies are checked against the vendored package.

Updating the hosted service to a new release:

```bash
# in the hosted repository
node scripts/ops/xhd-vendor-runtime.mjs --from <release-dir-or-tag>
npm install
npm run typecheck && npm test
```

## Versioning

- `package.json` `version` follows semver for `@crosshead/runtime` and
  `@crosshead/protocol`, which are released together.
- The **release ID** is `<version>-<first 12 hex of the install tarball
  SHA-256>`. Installed runtimes store each release in
  `lib/runtime/<releaseId>` and skip the download when that directory exists,
  so the ID changes whenever the tarball changes.
- `ONLYBOTS_RUNTIME_CORE_VERSION` in `src/runtime/runtime-persistence.ts` is the
  runtime-home compatibility version. Change it only with a migration path for
  existing homes.

Compatibility constraints from already-installed clients:

- The installer and `crosshead update` read `RELEASE_ID`, `RELEASE_URL` and
  `RELEASE_SHA256` from `/install`; the release URL must be on the same origin.
  The updater additionally requires the operator to supply that SHA-256 from
  an independent channel and never performs unattended installation.
- The tarball must contain `package.json`, `package-lock.json` and
  `dist/runtime/{cli,daemon,local-runtime,codex-adapter,claude-code-adapter,pi-adapter,codex-bridge,codex-hook,claude-code-bridge,claude-code-hook}.js`.
  Older clients `require()` some of these modules directly during updates.
- Entries must be regular files or directories, without absolute paths or `..`.
- Installation runs `npm ci --omit=dev --ignore-scripts`.

Wire-protocol changes must stay readable by the oldest runtime still in use,
or the hosted service must keep serving the older shape until those runtimes
update.

## Security-sensitive hosted contracts

The client fails closed at the hosted boundary. Server releases paired with
this runtime must observe these rules:

- `/v1/auth/challenge` returns a base64url-encoded JSON object with
  `version=crosshead_auth_v1`, `purpose=crosshead_hosted_auth`, the exact
  service audience and requesting `npub`, a random nonce, and bounded
  `issued_at`/`expires_at` timestamps. Opaque 32-byte signing challenges are
  rejected because they can be Nostr event IDs.
- Handoff capsules are signed and verified locally. The client never sends an
  `nsec` header and does not trust hosted `validation` or `inspection` fields.
  Cross-machine exchange uses the signed capsule bytes.
- Hot-memory `content` is a `crosshead_signed_memory_v1` envelope. The server
  stores it opaquely. Reads with a missing, altered, foreign, or wrong-scope
  signature are discarded locally.
- Hosted context text, manifests, warnings, lifecycle actions, inbox items,
  dream-review items, obligations, and status details are not injected into an
  agent prompt. A future context aggregation protocol must return client-
  verifiable source envelopes rather than server-authored free-form
  instructions.
- Public-discovery consumers request `include_raw=true` and derive identity,
  payload, and routing fields only from a locally verified Nostr event.
