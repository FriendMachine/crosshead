# @crosshead/protocol

The Crosshead wire contract: request and response shapes for the hosted API,
schema version constants, validators for signed records (passports, trust
receipts, capability claims, handoff capsules) and the published JSON schemas.

It has no dependencies beyond Node.js built-ins. The Crosshead runtime and the
hosted service compile against the same version, so a breaking change to a
shared definition fails the build on both sides.

```ts
import { L402_IDEMPOTENCY_HEADER } from "@crosshead/protocol/dist/billing";
import type { ContinuityClaimCreateInput } from "@crosshead/protocol/dist/continuity-claims";
```

Schemas are under `schemas/`.
