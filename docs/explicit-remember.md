# Explicit remember and hot continuity

An explicit adapter `remember --content` writes the supplied text into bounded hot continuity, in addition to the existing warm-memory promotion request. A fresh session can receive that checkpoint without a successful hosted warm write. Normal workspace isolation, context bounds, history eviction and memory-mode policy still apply; this is not an unlimited or permanent archive.

The command already sends the explicitly supplied content to the runtime. This change also makes it eligible for ordinary hot-context delivery and configured hot sync. It does not enable automatic source-file excerpt collection. `CROSSHEAD_CAPTURE_SOURCE_EVIDENCE` stays opt-in and unchanged. Automatic excerpt collection would retain text from workspace reads beyond the agent's chosen summary; changing that default would require explaining that privacy tradeoff first.

The November 2026 benchmark additionally pointed its adapter wrappers at library modules instead of CLI bridge entry points. Those wrappers silently exited zero, so an attempted explicit command never emitted a lifecycle event. That harness defect is separate from this product defect: the product fix preserves content after a valid event reaches the runtime; it does not explain a missing event.

Regression coverage exercises local-only and normal hot-sync profiles, fresh sessions after restart, Codex-to-Claude delivery, source capture disabled, and isolation from a different workspace. These deterministic tests do not measure model task completion or comparative performance.
