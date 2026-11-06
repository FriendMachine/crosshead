# Local hot memory with background sync

Local hot sync is the default beginning with v0.5.0-alpha.7. The server must
run migration 0034 and enable `CROSSHEAD_HOT_SYNC_ENABLED=true`; participating
devices use protocol 2. The daemon owns this decision. Set
`CROSSHEAD_HOT_SYNC_ENABLED=false` in its environment only for an intentional
rollback to the previous hosted hook path.

## What happens locally

A completed lifecycle capture is signed and written atomically, with file and
directory fsync, before it is acknowledged. Hooks read the verified local view;
ordinary hot-context delivery does not wait for authentication or the cloud.
Explicit paid recall remains a hosted operation. Ordinary hooks do not request
billable context packs or reflection, and do not wait for hosted inbox/dream HUD
refreshes. Archive uploads run outside the lifecycle mutation lock and cannot
block local capture or hot sync. Local-only profiles retain
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

Unsent legacy queue checkpoints are imported into the fsynced outbox before
new uploads. Their exact original snapshots remain in private
`legacy-recovery-*.json` files, listed by `legacyRecoverySnapshots` in sync
status. These bounded recovery copies protect ambiguous work if first discovery
reveals a reset on another machine. Unsupported snapshots and snapshots with a
known reset remain queued for explicit recovery; they do not block other
profiles' local hooks. Do not automatically re-upload recovery copies after a
reset without deciding whether they predate the deletion.

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

Each launch candidate requires public release and deployment validation: tagged artifacts, production installer/update/rollback checks, a real
two-device production run, and authenticated production capacity measurements.
Local test latency is development evidence, not a production capacity claim.

## Review fixes in alpha.3 (protocol 2)

The server advertises capability version 2. Upload and reset requests include
`protocol_version: 2`; the server rejects earlier/missing mutation versions with
426 `hot_sync_upgrade_required`. Upgrade every experimental alpha device before
resuming sync. Older alpha clients stop at capability discovery and keep their
local outbox. Signed v1 documents already stored by alpha.2 remain readable.

The verified cloud CAS revision is authoritative for acknowledged history.
Clients merge only their durable, unacknowledged captures into it, rather than
unioning an obsolete acknowledged snapshot back into newer cloud state. This
allows retiring device watermarks once none of that device's checkpoints remain
in the bounded view. Vectors therefore track at most the 12 retained checkpoint
devices, not every installation ever used. A returning installation first reads
the current revision, retains its genuine pending work, and cannot restore
pruned acknowledged checkpoints from its old base. Device sequences are retained
provenance within that bounded view, not lifetime counters.

Same-ID divergent pending captures become deterministic conflict variants,
including a retry after a lost acknowledgment. Upload acknowledgment removes
only the specific signed outbox record that was sent. A conflict group too large
to fit the hot budget fails explicitly, retains its outbox records and verified
conflict evidence, and requires inspection/reset instead of evicting a variant
and claiming success.

Signed `withheld` and `superseded` ID sets retain suppression for each surviving
checkpoint even if the checkpoint declaring the relationship is pruned. These
sets are compacted with the retained view; hot memory is still bounded history.
A lone surviving conflict variant stays marked as disputed.

Pending resets run before legacy migration; ordinary captures upload only after
migration succeeds. Legacy checkpoints enter the durable outbox before a new
capture can create the first cloud revision, including after a restart. If legacy
discovery or import fails, ordinary uploads wait for a successful retry while
pending resets can still proceed. Migration checks for pending reset both before
and after its awaited read. A reset failure does not stop other selected scopes
from attempting their sync. Neither a reset before first import nor a reset
racing that read can repopulate the cleared scope.

Conditional-read ETags bind identity, namespace, scope, epoch and revision.
Server responses include `Vary: Authorization`. The service applies both an IP
allowance before authentication (including invalid credentials) and a verified
identity allowance after authentication; creating sessions cannot multiply it.
These counters are per server process, as with the existing limiter; aggregate
multi-instance capacity still requires deployment measurement.

## Requesting hosted private-memory deletion

Email `support@crosshead.sh` with the agent's public `npub`. Support sends a
short-lived deletion challenge. Run the supplied command on the machine holding
that identity:

```sh
crosshead sign-deletion-challenge '<challenge>' --confirm erase-private-memory --json
```

The CLI checks the challenge's purpose, identity, server and expiry against the
local profile. Send the resulting signed proof to support; the private key stays
on your machine. This authorizes deletion of that identity's hosted private
memory across profiles and namespaces, and permanently disables the cloud
identity so an old device cannot upload it again. Local files remain on your
machines. Shared organizations, public publications and required financial
records have separate ownership and retention rules.
