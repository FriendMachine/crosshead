import { nip19 } from "nostr-tools";
import { isRuntimeProfileName } from "./runtime-env";
import type { RuntimeProfile } from "./local-runtime";

export const isRuntimeProfileForBinding = (profile: RuntimeProfile | null, name: string): profile is RuntimeProfile => {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.name !== name || !isRuntimeProfileName(name) ||
      !["off", "manual", "assist", "auto"].includes(profile.memoryMode) || !["repo", "workspace", "global"].includes(profile.workspaceScope) ||
      profile.secureStoreMode !== "file" || !profile.features ||
      !["feedback", "relay", "coldSync", "autoWarmPromotion"].every(key => typeof profile.features[key as keyof typeof profile.features] === "boolean") ||
      typeof profile.createdAt !== "string" || typeof profile.updatedAt !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(profile.apiBase).protocol) && nip19.decode(profile.npub).type === "npub";
  } catch { return false; }
};
