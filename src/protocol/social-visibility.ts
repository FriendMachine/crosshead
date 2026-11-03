// Visibility recorded on memory entries captured from shared conversations.
export const SOCIAL_DISCLOSURE_SENSITIVITY_VALUES = [
  "normal",
  "pii",
  "confidential",
  "off_the_record",
] as const;
export type SocialDisclosureSensitivity = (typeof SOCIAL_DISCLOSURE_SENSITIVITY_VALUES)[number];

export type SocialVisibilitySnapshot = {
  capturedAt: string;
  audiencePolicyRef: string;
  members: string[];
  memberCount: number;
  source: "ingress" | "resolver" | "unknown";
  notes?: string[];
};
