# Contributing

1. `npm ci`, then `npm run typecheck`, `npm run check:boundary`,
   `npm run build` and `npm test`.
2. Keep hosted-service logic out of this repository. `src/protocol` holds
   definitions both sides share and must stay dependency-free; see
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
3. Changes to the install tarball layout, the release ID or the update flow
   must keep working for already-installed runtimes. Run
   `npm run release:build && node scripts/verify-release.mjs --smoke`.
4. A new runtime dependency must be added to `package.json` and to the
   allowlist in `scripts/verify-release.mjs`, with a reason in the commit.
5. Wire-protocol changes need a matching change in the hosted service. Note the
   compatibility impact in the pull request.

Unless explicitly stated otherwise, a contribution intentionally submitted for
inclusion is provided under the Apache License 2.0, as described in section 5
of [LICENSE](LICENSE). Do not submit code or assets you do not have the right to
license. The Crosshead name and brand assets are not licensed for reuse; see
[TRADEMARKS.md](TRADEMARKS.md).
