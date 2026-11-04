# Hot sync implementation branch

This is an experimental implementation of hosted Task 159 / PRD 007. The default
runtime behavior is unchanged. `CROSSHEAD_HOT_SYNC_ENABLED=true` selects the new
path in a test daemon. Use a disposable runtime home and a server with the same
flag plus migration 0034.

Implemented: locally signed, atomic hot records; background conditional uploads;
verified pulls; profile/origin/identity isolation; stable checkpoint IDs;
concurrent-write conflict preservation; reset epochs and conditional reset;
per-device observation watermarks so acknowledged pruning cannot resurrect old
checkpoints; and preservation of captures made during an upload. The server's
new API is separate from legacy unconditional writers.

Current development limits: the signed snapshot, including pending work, must
fit 128 KiB and 256 checkpoints. Capture reports a failure if that bound is
exceeded. Acknowledged history is reduced to 12 checkpoints and 30,000 characters.
This is not yet the spec's larger durable outbox. The feature must remain opt-in.

Remaining before release:

- Durable outbox batching and total local disk quota; bounded device vectors.
- Portable workspace mapping/link command and verified legacy import.
- CLI reset, status/doctor presentation, and durable background-worker shutdown.
- Capability negotiation, conditional GET, Retry-After/backoff, and fair bounded
  request concurrency (the draft manager currently refreshes on a fixed interval).
- Explicit correction/conflict relationships in capture and prompt selection.
- Full installed-hook, API/authorization, migration, update/rollback, and load
  acceptance matrix against the candidate artifacts.

Tests under `tests/runtime/hot-sync.test.ts` exercise signature boundaries,
merge idempotence, pruning watermarks, capture during upload, offline restart,
two replicas, and stale writes after reset. These are foundational tests; they
are not a launch-readiness signoff.
