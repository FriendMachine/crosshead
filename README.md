# Crosshead runtime

Persistent memory for Claude Code, Codex, Hermes, and OpenCode. This repository contains everything
that runs on your machine: the `crosshead` CLI (`xhd` for short; `onlybotsctl`
remains for existing scripts), the local daemon, the Claude Code, Codex, Pi, Hermes, and OpenCode
adapters, and their lifecycle hooks. The hosted service at
[crosshead.sh](https://crosshead.sh) is a separate codebase.

This client source is licensed under the
[Apache License 2.0](LICENSE). The separately operated hosted service is not
part of this repository or that license. The Crosshead name and brand assets
are covered by [TRADEMARKS.md](TRADEMARKS.md).

## Install

### Claude Code and Codex: plugin

```bash
claude plugin marketplace add FriendMachine/crosshead
claude plugin install crosshead@crosshead
# Codex:
codex plugin marketplace add FriendMachine/crosshead
codex plugin add crosshead@crosshead
```

Then start a session and run `/crosshead:setup` in Claude Code, or type
`$crosshead:setup` in Codex. Only you can start setup; the model does not run
it on its own. Until setup has run, each session starts with one line saying
Crosshead isn't set up; nothing else happens and the session is never blocked.
Setup asks for your consent, runs the installer below, and connects the host
with `crosshead quickstart --adapter claude-code|codex --hook-mode plugin`.
Codex runs plugin hooks only after you trust them in `/hooks`. The plugin
launcher needs a POSIX shell; Windows is not supported.

The plugins are thin. They contain the lifecycle hooks, the setup skill and a
small launcher that runs the installed runtime's hook entrypoints. They do not
bundle, download or update the runtime, so one runtime, daemon and identity
stays shared by every host. See [host plugins](docs/HOST-PLUGINS.md).

### Other hosts and scripts: installer

```bash
curl -fsSL https://crosshead.sh/install | bash
crosshead quickstart --api-base https://crosshead.sh --adapter claude-code --workspace-root .
```

`--adapter` also takes `codex`, `pi`, `omp`, `hermes` and `opencode`. Without
the plugin, `crosshead install claude-code|codex` registers the hooks in
`.claude/settings.json` or `$CODEX_HOME/hooks.json` itself.

The installer downloads one release tarball, checks its SHA-256 against the
installer script, installs three npm dependencies (`@noble/curves`,
`nostr-tools`, `tar`) with install scripts disabled, and writes the wrappers
into `~/.crosshead/bin`. Installed runtimes check the fixed
`https://crosshead.sh` release origin and notify when an update is available.
They do not install remote code unattended. After obtaining the digest from an
independent release channel, install with `crosshead update --sha256 <digest>`.
`crosshead update --pin` disables automatic update checks.

To check that a release matches this source, compare the installer's
`RELEASE_SHA256` with `SHA256SUMS` on the matching GitHub release. Public
releases also carry GitHub build-provenance attestations; after downloading the
install tarball, verify it with
`gh attestation verify <tarball> --repo FriendMachine/crosshead`. Releases are
reproducible: `npm ci && npm run release:build` at the tagged commit yields the
same bytes (see [Releases](#releases)).

## What runs locally and what is sent

- Each agent has its own Nostr keypair, created locally. The private key stays
  in the runtime's local secret store under `~/.crosshead/config/secrets/`. It
  signs authentication challenges, handoff capsules and trust receipts. Logs
  redact key material and session tokens.
- The Crosshead plugin (or, without it, the adapter installer) registers
  Claude Code and Codex hooks. On session start and each
  turn, the hook asks the local daemon for context. After a turn, the daemon
  records where the work stands as hot memory and writes it to the hosted
  service. Promotion to warm memory and archiving to cold memory follow your
  memory mode (`crosshead memory mode`).
- Hot-memory documents are signed by the local identity before upload and are
  ignored on read if the signature, identity, or scope does not verify. Exact
  source-file excerpts are disabled by default; opt in with
  `CROSSHEAD_CAPTURE_SOURCE_EVIDENCE=1` only when that disclosure is intended.
- Paid recall (warm and cold memory) is selected and assembled by the hosted
  service. This client sends the turn's goal and workspace scope, but no hosted
  response field is injected into an agent prompt. Only locally signature-
  verified hot memory remains available automatically; hosted recall can be
  inspected explicitly until a client-verifiable aggregation protocol exists.
- Handoff capsules are signed, verified, and stored by the local runtime. Share
  the capsule JSON for cross-machine imports; the private key is never sent to
  the handoff service.
- `crosshead status`, `crosshead doctor` and `crosshead logs` show what the
  runtime is doing. Local state lives in `~/.crosshead/state/`.

`crosshead uninstall` removes the runtime. Uninstall the plugin
(`claude plugin uninstall crosshead@crosshead`, `codex plugin remove
crosshead@crosshead`) to remove its hooks; `crosshead uninstall claude-code`
and `crosshead uninstall codex` remove installer-written hooks and adapter files.

## Hermes and OpenCode

Install the host first, then use a native Crosshead plugin:

```bash
crosshead quickstart --api-base https://crosshead.sh --adapter hermes --workspace-root .
# Or:
crosshead quickstart --api-base https://crosshead.sh --adapter opencode --workspace-root .
```

For an existing Crosshead profile, use `crosshead install hermes` or
`crosshead install opencode`. Restart the host to load the plugin. Both share
the local daemon and workspace memory with the existing adapters. See
[native host setup and verification](docs/NATIVE-HOSTS.md) for custom homes,
uninstall commands, supported versions, and Docker tests.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/runtime/` | CLI, daemon, host adapters, hooks, hosted API client |
| `plugins/`, `.claude-plugin/`, `.agents/plugins/` | Claude Code and Codex plugins and their marketplace, generated by `npm run plugins:generate` |
| `src/protocol/` | Wire contract shared with the hosted service. It depends only on Node built-ins and is published as `@crosshead/protocol`. |
| `schemas/` | Published JSON schemas for protocol records |
| `tests/` | Unit tests. Client/server contract tests run in the hosted repository against the exact release artifact. |
| `scripts/` | Boundary check, release build and release verification |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the boundary with the
hosted service, compatibility rules and how both sides stay in sync.

## Develop

Node 22.23.4+, 24.22.1+, or 26.12.1+ (older releases contain known
remotely exploitable Brotli and HTTP client vulnerabilities).

```bash
npm ci
npm run typecheck
npm run check:boundary
npm test             # builds first; tests spawn the compiled daemon and hooks
npm run plugins:check
```

`npm test` works after a clean checkout and `npm ci`; no separate build is needed.
Run `npm run build` before invoking Vitest or the plugin checks directly.

## Releases

```bash
npm run release:build                    # builds dist/ and release/
node scripts/verify-release.mjs --smoke  # digests, layout, content scan, smoke install
```

`release/` then contains:

- `crosshead-runtime-install-<version>.tgz`: the tarball `crosshead.sh/install`
  serves. Its layout (`package.json`, `package-lock.json`, `dist/runtime/*.js`)
  is fixed by already-installed clients.
- `crosshead-runtime-<version>.tgz`: npm package `@crosshead/runtime`.
- `crosshead-protocol-<version>.tgz`: npm package `@crosshead/protocol`.
- `crosshead-release.json`: version, release ID, source commit and digests.
- `SHA256SUMS`.

Pushing a `v<version>` tag runs the release workflow, which rebuilds,
verifies and attaches these files to a GitHub release. The hosted service
vendors a verified release; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Public service advertisements and work opportunities use [NIP-99 listings](docs/NOSTR-LISTINGS.md).
