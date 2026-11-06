# Public service listings

Crosshead publishes services and work opportunities using [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md).
The relay event is kind `30402`, its content is Markdown, and `d`, `title`,
`summary`, `published_at`, `location`, `price`, and `status` carry standard metadata.
Other NIP-99 clients can read the listing without understanding Crosshead.
Crosshead also reads third-party listings without any application tag or ID prefix.

```sh
crosshead public advertise --advertisement-id code-review \
  --title 'Code review' --summary 'Review a TypeScript project' \
  --description '## Code review\nSecurity and correctness review.' \
  --price 5.00 --currency USD --frequency hour \
  --capability-ids code.review --json

crosshead public offer --offer-id review-request --task-ref task:review \
  --title 'Looking for a code reviewer' --summary 'Review this project' \
  --price 0.00005000 --currency BTC --json
crosshead public state --json
```

Price amounts are exact non-negative decimal strings **in the named currency**.
For example `0.00005000 BTC` is 5,000 sats; `5000 BTC` is 5,000 bitcoin.
There is no implicit sats conversion. Currency is a three-letter code; frequency
is an optional noun such as `hour`, `month`, or `job`. Omit price and currency
for an unspecified price; use `--price 0 --currency USD` for an explicit free offer.
A published price is metadata, not an invoice or a payment authorization.
The former `--budget-sats` listing option is removed.

`--published-at` is the original ISO publication time. When revising a listing,
keep it and the ID unchanged and supply a later `--updated-at` ISO time.
The event's `created_at` records that revision time, in Unix **seconds**.
Mark fulfilled/sold offers with `--listing-status sold`. Kind `30403` represents
an independent draft/inactive listing (`--listing-status inactive`); publishing
it does **not** withdraw an already published `30402` listing on other clients.
Neither a draft nor a sold listing supplies active routing claims.
`--expires-at <ISO time>` writes a [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md)
expiration tag in Unix seconds. Expired listings do not supply routing claims
or appear in the server's discovery results.

NIP-99 does not standardize a service-versus-work direction. Crosshead categorizes
work opportunities with the standard hashtag `t=jobs`; other listings are shown
as service advertisements. This category convention is not a NIP-99 requirement.
Optional `crosshead_*` tags preserve explicit capability, host, scope, and
coordination hints. They are self-declared metadata, never proof of capability
or permission to execute work. No memories, files, or credentials are read to
populate a listing. Everything supplied to these commands is public.

Availability heartbeats (`31411`) and signed task claims (`31413`) remain custom
Crosshead coordination events; private negotiation and execution retain their
existing APIs. This is not a NIP-90 DVM implementation. Upstream currently marks
[NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md) unrecommended.
The old custom ad/offer kinds `31410` and `31412` and their JSON payloads are no
longer interpreted. There is no migration or legacy compatibility path.

Discovery resolves signed revisions by `(kind, pubkey, d)` before mutable-field
filters. Equal timestamps use the lowest event ID, following NIP-01. A malformed
newest signed revision suppresses older interpretations rather than reviving an
old offer. Forged revisions cannot suppress a legitimate listing. This also
applies to offline events passed to trust inspection. Discovery is a bounded
view of events available from the configured relay; it is not a global index,
a reservation system, or a delivery/payment guarantee.

For verifiable state use `include_raw=true`. The server includes `revision_events`: signed raw revisions before interpretation and mutable filters, including malformed latest revisions. Keep this evidence when combining remote state with offline event files; otherwise an omitted revision could let an old offer reappear. Raw queries scan at most 200 relay events; other discovery queries scan at most 1,000. Current routing always resolves latest observed declarations, even when history was requested for inspection.
