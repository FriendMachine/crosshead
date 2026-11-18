import { isRuntimeProfileForBinding } from "./runtime-profile-validation";
import type { HookHost } from "./host-hook-spec";
import { loadProfile, resolveRuntimePaths } from "./runtime-persistence";
import { tokenUsagePhase } from "./token-usage";
import { taskEvidenceCaptureEnabled } from "./task-evidence";
import { readWorkspacePolicyForHook, workspaceHookForInvocation } from "./workspace-hooks";

type Flags = Record<string, string | boolean>;
type Payload = Record<string, unknown> | null;

/** Resolve scoped capture once, before either host touches transcripts or starts a daemon. */
export const resolveWorkspaceHookDispatch = (
  host: HookHost, event: string, flags: Flags, readPayload: () => Payload, directory: (payload: Payload) => string
) => {
  const normalized = event.toLowerCase();
  const isToolFailure = normalized === "posttoolusefailure" || normalized === "post_tool_use_failure";
  const isPostToolUse = isToolFailure || normalized === "posttooluse" || normalized === "post_tool_use";
  if (isPostToolUse && (flags["source-excerpts"] === "off" || (!flags.binding && !taskEvidenceCaptureEnabled()))) return null;
  const paths = resolveRuntimePaths(typeof flags.home === "string" ? flags.home : undefined);
  const policy = readWorkspacePolicyForHook(paths, normalized, flags.binding);
  if (policy === false) return null;
  const selected = policy?.bindings.find(binding => binding.host === host && binding.id === flags.binding);
  if ((policy && !selected) || (!policy && flags.binding !== undefined)) return null;
  if (isPostToolUse && !(selected?.sourceExcerpts ?? taskEvidenceCaptureEnabled())) return null;
  const payload = readPayload();
  const scoped = workspaceHookForInvocation(policy, host, flags.binding, directory(payload));
  if (scoped === null) return null;
  let legacyUnscoped = false;
  let memoryOff = false;
  // A directory override can replace the selected binding's profile.
  const effective = scoped?.binding ?? selected;
  if (effective) {
    let profile: ReturnType<typeof loadProfile> = null;
    try { profile = loadProfile(paths, effective.profile); } catch { /* Invalid profile also pauses the binding. */ }
    if (!isRuntimeProfileForBinding(profile, effective.profile)) {
      if (["sessionstart", "session_start", "userpromptsubmit", "user_prompt_submit"].includes(normalized)) {
	console.error(`Crosshead profile ${effective.profile} is missing or invalid. Automatic memory is paused; run crosshead workspace check.`);
      }
      return null;
    }
    memoryOff = profile.memoryMode === "off";
    if (memoryOff && !tokenUsagePhase(normalized)) return null;
    legacyUnscoped = effective.legacyUnscoped === true && effective.legacyNpub === profile.npub;
  }
  return { paths, runtimeHome: paths.home, payload, scoped, legacyUnscoped, isPostToolUse, isToolFailure, memoryOff };
};
