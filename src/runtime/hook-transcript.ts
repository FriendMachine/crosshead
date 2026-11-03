import { closeSync, fstatSync, openSync, readSync } from "fs";

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// Read only the tail of a native transcript. Partial JSONL records and a concurrent
// trailing write must not hide the preceding complete assistant message.
export const readLastAssistantMessage = (filePath: string | null, sessionId?: string | null): string | null => {
  if (!filePath) return null;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/);
    for (const line of lines.reverse()) {
      let entry: Record<string, unknown> | null;
      try { entry = object(JSON.parse(line)); } catch { continue; }
      if (!entry) continue;
      const recordedSession = entry.sessionId ?? entry.session_id;
      if (sessionId && typeof recordedSession === "string" && recordedSession !== sessionId) continue;
      const payload = object(entry.payload);
      for (const key of ["last_agent_message", "lastAgentMessage", "last_assistant_message", "lastAssistantMessage"]) {
	if (typeof payload?.[key] === "string" && payload[key].trim()) return payload[key].trim();
      }
      const message = object(entry.message) ?? object(payload?.payload) ?? payload;
      if (message?.role !== "assistant") continue;
      const content = message.content;
      if (typeof content === "string" && content.trim()) return content.trim();
      if (!Array.isArray(content)) continue;
      const text = content.flatMap((block) => {
	const item = object(block);
	return item && ["text", "output_text"].includes(String(item.type)) && typeof item.text === "string" ? [item.text] : [];
      }).join("\n\n").trim();
      if (text) return text;
    }
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
};
