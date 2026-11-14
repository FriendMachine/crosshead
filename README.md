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
Setup asks where Crosshead should run and previews the directories, profiles,
and files before applying the setup. In Codex, review the new project hooks
in `/hooks`. The plugin launcher needs a POSIX shell.

The plugins are thin. They contain the lifecycle hooks, the setup skill and a
small launcher that runs the installed runtime's hook entrypoints. They do not
bundle, download or update the runtime, so one runtime, daemon and identity
stays shared by every host. See [host plugins](docs/HOST-PLUGINS.md).

### Choose where Crosshead runs

```bash
curl -fsSL https://crosshead.sh/install | bash
crosshead quickstart
```

Quickstart recommends the current project. Add more directories, opt into all
projects, or choose manual commands only. Each directory can use Codex, Claude
Code, or both, with an existing or new profile. Project hooks use their selected
profile at startup and resume, including when the launcher skips `direnv`.

For scripts and agents, preview the same setup as JSON:

```sh
crosshead quickstart --scope project --workspace-root . --adapter both --profile work --dry-run --json
```

Use an existing profile name or pass `--api-base https://crosshead.sh` to create
one. Apply by removing `--dry-run`. After starting a session, use
`crosshead workspace check` to see the configured profile and observed startup
and resume. Run the same check in an unselected directory to inspect its scope.

```sh
crosshead workspace add --workspace-root ../other-project --adapter codex --profile work
crosshead workspace list
crosshead workspace remove --workspace-root ../other-project
```

Project setup writes local hook settings for each selected host. Codex settings
are excluded locally through Git's info/exclude file. When a repository already
tracks its Codex hooks, Crosshead uses a directory-restricted user registration
and preserves the tracked file. Claude Code uses settings.local.json. Existing
user-wide Crosshead hook commands for this runtime are listed in the preview
when setup replaces them. The runtime skips old Crosshead plugin and hook
registrations after scoped setup. Review and restart host sessions after a
scope change. Source excerpts are off for new bindings unless you choose
`--source-excerpts on`. Checkpoints can still contain prompts and summaries.

Other hosts use `crosshead quickstart --adapter pi|omp|hermes|opencode`.

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

## Choose what memory can retain

By default Crosshead keeps bounded task summaries, explicitly saved memory, and
bounded excerpts of the workspace files and command output your agent reads
while it works. The excerpts are what let a fresh session recover an exact
specification or rule instead of a summary of it.

Those excerpts can be stored, synced through the configured service, and sent
to a later coding-model session. Filters exclude some sensitive paths and
credential-like text, but cannot guarantee that every secret is removed. If a
repository contains text you do not intend to disclose through those paths,
turn excerpt capture off before launching the host:

```bash
export CROSSHEAD_CAPTURE_SOURCE_EVIDENCE=0
codex  # or launch Claude Code from this shell
```

With capture off, memory still holds summaries and explicit writes, which can
themselves contain code; this is not a guarantee that code never enters memory.
Turning capture off does not delete existing memory. Verify a concrete rule in
a fresh session after choosing either setting.

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
  ignored on read if the signature, identity, or scope does not verify. Bounded
  source-file capture follows each scoped binding's source excerpt choice. Legacy
  installs capture excerpts by default and accept
  `CROSSHEAD_CAPTURE_SOURCE_EVIDENCE=0` to opt out.
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

Set `CROSSHEAD_PROFILE` for explicit CLI commands. Legacy hooks retain their
installed profile.
`ONLYBOTS_PROFILE` is the legacy alias. Explicit CLI `--profile` takes precedence.
Scoped hooks use the profile selected during setup. Use
`crosshead memory mode off --profile <name>` to stop automatic memory hooks for
that profile, or `crosshead workspace remove` to detach a project.

Local-only checkpoints are stored per profile. A legacy flat store remains
readable for its sole existing local-only profile, whose identity is pinned
before creating another profile. If several profiles already shared an unowned
store, review its `state/local-hot-memory/*.json` files to establish ownership.
Scoped setup retains matching subdirectory and symlink history. Its preview
shows adoption of earlier unscoped checkpoints when one project is selected
for an existing profile. Later unscoped captures require an explicit workspace.

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
