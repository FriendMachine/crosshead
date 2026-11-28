import { randomUUID } from "node:crypto";

export interface AgentMailRequest {
  action: "note" | "assign" | "reply";
  text: string;
  to?: string;
  parent?: string;
  requestId: string;
}

export function parseMailCommand(command: string, flags: Record<string, string | boolean>): AgentMailRequest {
  const action = command === "send" ? "note" : command;
  if (action !== "note" && action !== "assign" && action !== "reply") throw new Error("Unknown mail action");
  const text = flags.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("--text is required");
  const parent = typeof flags.parent === "string" ? flags.parent : undefined;
  const to = typeof flags.to === "string" ? flags.to : undefined;
  if (action === "reply" && !parent) throw new Error("reply requires --parent <message-event-id>");
  if (!to && !parent) throw new Error("mail requires --to <profile-name|npub> or --parent");
  const requestId = flags["request-id"] ?? randomUUID();
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("Invalid --request-id");
  return { action, text, to, parent, requestId };
}
