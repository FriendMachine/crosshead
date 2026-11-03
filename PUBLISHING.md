# Publication checklist

This public repository was created from the reviewed v0.4.4 client tree as a
clean root. The older private repository remains private because an early
commit contained hosted-service files outside this client's Apache-2.0 scope.
`package.json` retains `"private": true` as an independent guard against
accidental npm publication.

1. **License — complete.** `LICENSE`, `package.json`, the release builder and
   release verifier apply and ship Apache-2.0. `TRADEMARKS.md` keeps the code
   license separate from the Crosshead name and brand assets.
2. **Clean history — complete.** `FriendMachine/crosshead` begins with the
   reviewed client-only tree. The exact public root was scanned before push;
   `.gitleaksignore` documents the credential-filtering test fixture. Reviewers
   can start with [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).
3. **Review operator-facing code.** The organizational-worker daemon API types
   and federation-status contract are present because the daemon serves them.
   Decide whether to keep them public or move them behind an extension package.
4. **Registry scope.** Create the `crosshead` npm organization (or rename the
   packages) and add an `NPM_TOKEN` environment secret, or configure npm
   trusted publishing for this repository.
5. **Provenance.** The release workflow attaches build provenance attestations
   once the repository is public (GitHub requires a public repository or
   Enterprise Cloud for private attestations).
6. **Turn on npm publishing.** Only when the registry scope is ready, remove
   `"private": true` and set the repository variable `NPM_PUBLISH=true`. The
   next tag publishes `@crosshead/protocol` and `@crosshead/runtime` with npm
   provenance. Public GitHub source and releases do not require npm publishing.
7. **Hosted service.** Switch the hosted repository from vendored tarballs to
   the registry packages and pinned release URLs.
8. **Public docs.** Link the repository from crosshead.sh and describe how to
   verify an installed release against `SHA256SUMS`.
