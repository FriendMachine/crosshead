import type { Npub } from "./base";
import { canonicalJson } from "./agent-deals";
import { type PersistentOrganization, validatePersistentOrganization } from "./trust";

export const ORGANIZATION_CHARTER_SCHEMA_VERSION = "crosshead_org_charter_v1";

/** A `PersistentOrganization` document signed by one of its founding agents. */
export type SignedOrganizationCharter = {
  schemaVersion: typeof ORGANIZATION_CHARTER_SCHEMA_VERSION;
  document: PersistentOrganization;
  signerNpub: Npub;
  /** BIP-340 Schnorr signature over `organizationCharterPayload`, hex. */
  signature: string;
};

export const organizationCharterPayload = (charter: Omit<SignedOrganizationCharter, "signature">): string =>
  canonicalJson({ schemaVersion: charter.schemaVersion, document: charter.document, signerNpub: charter.signerNpub });

/** Structural checks; the caller verifies the signature against `organizationCharterPayload`. */
export const validateSignedOrganizationCharter = (value: unknown): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["charter must be an object"];
  const charter = value as Record<string, unknown>;
  const errors: string[] = [];
  if (charter.schemaVersion !== ORGANIZATION_CHARTER_SCHEMA_VERSION) errors.push(`charter.schemaVersion must be ${ORGANIZATION_CHARTER_SCHEMA_VERSION}`);
  if (typeof charter.signerNpub !== "string" || !/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(charter.signerNpub)) errors.push("charter.signerNpub must be an npub");
  if (typeof charter.signature !== "string" || !/^[0-9a-f]{128}$/.test(charter.signature)) errors.push("charter.signature must be a 64-byte hex Schnorr signature");
  errors.push(...validatePersistentOrganization(charter.document).map((error) => `charter.document: ${error}`));
  const founders = (charter.document as PersistentOrganization | undefined)?.founderAgentRefs ?? [];
  if (Array.isArray(founders) && !founders.some((founder) => founder?.npub === charter.signerNpub)) {
    errors.push("charter must be signed by one of its founding agents");
  }
  return errors;
};
