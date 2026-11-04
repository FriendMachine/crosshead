# Local hot memory with background sync

The `feat/local-first-hot-memory` branch provides the opt-in implementation of
hosted Task 159 / PRD 007. Enable `CROSSHEAD_HOT_SYNC_ENABLED=true` in the daemon's
environment, with a server running migration 0034 and the same flag. Start with
a disposable runtime home. This alpha candidate is not a published release.

## What happens locally

A completed lifecycle capture is signed and written atomically, with file and
directory fsync, before it is acknowledged. Hooks read the verified local view;
ordinary hot-context delivery does not wait for authentication or the cloud.
Explicit paid recall remains a hosted operation. Local-only profiles retain
their existing behavior.

Pending checkpoints have a separate durable outbox. They survive restart,
network failure, and retry exhaustion, even when they no longer fit the recent
context view. Each upload is at most 128 KiB; recent context retains at most 12
checkpoints and 30,000 characters, with the existing 4,200-character prompt
budget. The store allows 64 MiB per identity and API origin. A full or unwritable
store fails the new capture explicitly and preserves existing pending captures.

The daemon is the only writer. Its worker discovers cloud scopes, verifies
signatures, uses conditional reads and writes, and reconciles conflicts. It
prioritizes active workspaces and pending writes while rotating through recovery
scopes. It honors rate-limit Retry-After, retries with bounded exponential
backoff and jitter, and stops scheduling while continuity is paused. Shutdown
waits for in-flight work before releasing the runtime-home ownership lock.

## Multiple machines and commands

Use the same identity and profile name on both machines. Keep the private key in
each machine's local secret store. The server never supplies it. Profile names
produce separate opaque namespaces. API origins and identities have separate
local stores.

Git workspaces use an identity-keyed digest of a sanitized origin remote, so
SSH and HTTPS clones of the same repository map together. Paths, remote
credentials, and explicit workspace labels are not uploaded as workspace IDs.
For a project without a matching remote, link each clone before capturing:

```sh
crosshead workspace link --name my-project --workspace-root /path/to/project
crosshead memory sync
crosshead status --json
crosshead doctor --json
crosshead memory hot --inspect
crosshead memory hot reset --scope <scope-from-memory-sync>
```

These controls support `--home` and `--profile`. Mutation and inspection commands
use the authenticated local daemon. `status` exposes pending count and scopes,
oldest pending timestamp, last successful sync, remote revision and epoch,
conflicts, reset-discard counts, and safe error codes. “Saved locally” means
cloud synchronization is still pending; it is not a cloud acknowledgment.

Reset hides the local scope immediately, then increments its cloud epoch when
online. A returning device discards its old-epoch captures instead of uploading
them. Other devices can still read their offline copy until they reconnect.
Captures for a pending-reset scope fail explicitly until the reset syncs.

Distinct findings merge by stable event ID. Same-ID divergent content remains
inspectable under deterministic conflict variants. Explicit `supersedes` and
`conflictsWith` references are preserved; disputed claims are withheld from
automatic prompts. The client does not infer semantic contradictions from text.
Hot retention remains bounded, so use the existing archive for permanent history.
Signed hosted content is plaintext, not end-to-end encrypted.

## Existing installations and rollback

Verified legacy checkpoints for a known local workspace are imported once, only
when its revisioned scope is absent. Later legacy updates produce a persistent
mixed-version warning; upgrade every device before relying on cross-device
continuity. Legacy writers use a separate endpoint and cannot overwrite the
revisioned store. Unmapped remote workspaces remain inspectable until linked
locally and never enter an unrelated workspace's prompt.

Deploy the server capability before releasing the client. If the server gate is
disabled or the server is rolled back, leave the client gate enabled: local
capture/read continues, pending uploads remain durable, and status reports the
sync problem. Turning off the client gate explicitly returns to legacy behavior;
it does not merge or upload the new outbox. Re-enabling it resumes that outbox.

## Verification and release boundary

Tests cover offline restart beyond ten retries; an outbox larger than an upload;
concurrent capture/upload; two-device merging; reset resurrection; quota and disk
failure; tampered signatures; workspace/profile/identity isolation; migration;
Retry-After; and conflict withholding. The compiled daemon test uses SIGKILL
between capture and read, then verifies Codex, Claude Code, and Pi context through
its authenticated local API, including reset and ownership controls.

This branch still requires public release and deployment validation before a
launch: tagged artifacts, production installer/update/rollback checks, a real
two-device production run, and authenticated production capacity measurements.
Local test latency is development evidence, not a production capacity claim.
