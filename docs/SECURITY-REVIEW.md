# Security review brief

This brief is for an independent reviewer of the Crosshead client. It gives the
scope, how to build and run the code, the trust boundaries and where each one
lives in the source. It does not contain findings; the reviewer should not take
any statement here as a security claim to be trusted without checking.

## Revision under review

Review the current `main` commit. This public repository starts from the
reviewed v0.4.4 client tree as a clean root; older private history was
deliberately excluded because an early private commit contained hosted-service
implementation files that are not part of this Apache-2.0 client.

## Build and run

Node 22.23.4+, 24.22.1+, or 26.12.1+ (`.nvmrc` is 22; CI also runs Node 24).
No network services are needed for the test suite.

```bash
npm ci
npm run typecheck
npm run check:boundary         # source-level import rules
npm run build                  # tests spawn the compiled daemon from dist/
npm test                       # vitest
npm run release:build          # install tarball + npm packages in release/
node scripts/verify-release.mjs --smoke   # tarball contents, credential scan, install smoke
```

To exercise a real install against production:

```bash
export CROSSHEAD_HOME="$(mktemp -d)/.crosshead"
curl -fsSL https://crosshead.sh/install | bash
"$CROSSHEAD_HOME/bin/crosshead" status --json
```

Use a throwaway `HOME` as well if you install the Claude Code or Codex adapters,
because they edit host configuration. Please do not run load or abuse testing
against `crosshead.sh` without coordinating first (support@crosshead.sh).

## Scope

In scope: everything in this repository, the installer script served at
`https://crosshead.sh/install` (snapshot in
[security-review/install.sh](security-review/install.sh), sha256
`6961fb98…8edd2`, fetched 2026-10-29), and the GitHub Actions workflows.

Out of scope: the hosted service implementation (separate private repository).
Treat the hosted API as an untrusted remote peer: anything the client accepts
from it is in scope.

## Assets

| Asset | Where |
| --- | --- |
| Agent Nostr private key (identity; signs auth challenges, handoff capsules, trust receipts) | `~/.crosshead/config/secrets/`, `src/runtime/runtime-persistence.ts` |
| Hosted session tokens | runtime config/state, `src/runtime/hosted-client.ts` |
| Local daemon control token | `state/daemon.json`, `src/runtime/local-runtime.ts`, `src/runtime/runtime-http.ts` |
| Captured work context: hook transcripts, file-read evidence, hot/warm memory | `src/runtime/hook-transcript.ts`, `task-evidence.ts`, `hot-continuity.ts`, `local-hot-memory.ts` |
| The user's host-agent configuration (Claude Code, Codex, Pi) | adapters below |
| Code executing on the user's machine (the installed release itself) | install and update path below |

## Trust boundaries and entry points

1. **Install and self-update.** The production installer still reads release
   metadata and the tarball from one TLS origin. The client updater is pinned
   to `https://crosshead.sh`, requires a SHA-256 supplied through an independent
   channel, validates archive entries and runs
   `npm ci --omit=dev --ignore-scripts`. Background checks are notification-
   only. See `parseInstallerReleaseMetadata`, `validateRuntimeReleaseArchive`
   and `src/runtime/runtime-auto-update.ts`.
2. **Local daemon HTTP API.** It binds `127.0.0.1` on a configurable port
   (`src/runtime/local-runtime.ts:2042`). Requests require the
   `x-onlybots-local-token` header, including `/health`. The federation-status
   route uses a separate observer
   bearer token instead. Routing and authorization:
   `src/runtime/runtime-http.ts`. Consider other local users, other local
   processes, and browsers (cross-origin requests, DNS rebinding).
3. **Lifecycle hooks inside agent hosts.** Claude Code and Codex run
   `crosshead-*-hook` wrappers on session start, each prompt and turn end.
   Hooks read host transcripts and recently read workspace files, filter
   credential-looking content, and return context that the host injects into the
   model prompt. The client now excludes hosted response fields from that
   prompt; locally signed hot memory written by other runtimes remains a
   deliberate context path and should be reviewed as untrusted data.
   See `src/runtime/claude-code-hook.ts`, `codex-hook.ts`, `hook-runtime.ts`,
   `hook-transcript.ts`, `task-evidence.ts`, `startup-context.ts`.
4. **Host configuration changes.** Adapters write `.claude/settings.json`,
   Codex `hooks.json`, Pi/OMP extensions and shell wrappers in
   `~/.crosshead/bin`. Managed writes reject traversal, symlinked parents and
   symlink targets; the installed OMP extension is pinned to the selected
   runtime home. See `claude-code-adapter.ts`, `codex-adapter.ts`,
   `pi-adapter.ts`, `omp-adapter.ts`, `omp-extension-template.ts` and the shell
   quoting in `adapter-utils.ts`.
5. **Hosted API client.** Nostr challenge signing, request construction and
   handling of server responses: `src/runtime/hosted-client.ts`,
   `local-hosted-bridge.ts`, `agent-identity-attestation.ts`. Shared wire types
   and validators are in `src/protocol/`.
6. **Local state at rest.** Directories are created `0700` and files written
   atomically `0600`; internal runtime directories and append-only files reject
   symlinks (`src/runtime/runtime-persistence.ts`). Check every writer of
   secrets and memory uses these helpers.
7. **Process execution.** `spawn`/`execFileSync` call sites:
   `local-runtime.ts` (`runCommand`, daemon launch), `claude-code-adapter.ts`,
   `local-hosted-bridge.ts` (`flock`), `runtime-process.ts`,
   `runtime-auto-update.ts`. Generated runtime wrappers pin the current Node
   executable and clear Node preload variables; captured child output is
   bounded. Check arguments that derive from config, the environment or server
   responses.
8. **Environment variables.** `CROSSHEAD_*` names override the legacy
   `ONLYBOTS_*` names, including when empty (`src/protocol/environment.ts`).
   Home and hosted-API overrides change where the runtime stores or sends data;
   executable updates ignore these variables and use the fixed release origin.
9. **Supply chain and release pipeline.** Three runtime dependencies
   (`@noble/curves`, `nostr-tools`, `tar`), an allowlist in
   `scripts/verify-release.mjs`, reproducible builds
   (`scripts/build-release.mjs`), and SHA-pinned actions in
   `.github/workflows/`. The release job holds `contents: write` and
   `id-token: write`.

## Checks already run (2026-11-02, before the public clean-root push)

| Check | Result |
| --- | --- |
| `npm audit` (production and all dependencies) | 0 vulnerabilities |
| gitleaks over the exact public tree and its clean-root history | no unignored findings |
| `npm run check:boundary`, typecheck, tests | pass (299 tests) |
| `release:build` + `verify-release.mjs --smoke` | pass |

These are hygiene checks, not a review.

## Known context

These are decisions or open items, listed so they are evaluated rather than
rediscovered:

- The client requires an independently obtained digest for updates. It accepts
  either the legacy same-origin mirror or the exact versioned install artifact
  from `github.com/FriendMachine/crosshead`; arbitrary GitHub repositories, tags
  and filenames are rejected. The hosted production installer must switch to
  that release URL after publication to remove the same-origin bootstrap gap.
  GitHub build-provenance attestations start once the repository is public.
- The organizational-worker daemon API and federation-status contract ship in
  the public daemon but are only active with an operator composer
  (`src/runtime/daemon-host.ts`). Whether to keep them public is open
  (`PUBLISHING.md` item 3).
- Default passport trust zones name the workspace `repo:onlybots-erd`
  (`src/protocol/passports.ts:513`), a historical identifier.
- The installer is generated by the hosted service, not by this repository.

## Reporting

Send findings privately to support@crosshead.sh, or as a private document to
the repository owner. Include the file and line, a reproduction, impact and
severity. Do not open public issues or pull requests for unfixed findings.
