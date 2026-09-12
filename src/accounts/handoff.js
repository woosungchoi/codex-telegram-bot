import fs from "node:fs/promises";
import path from "node:path";

export async function portableHistory(sessionsDir, threadId) {
  if (!sessionsDir || !/^[a-zA-Z0-9-]+$/.test(threadId || "")) return "";
  const pending = [sessionsDir];
  let budget = 4000;
  while (pending.length && budget-- > 0) {
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        const handle = await fs.open(file, "r");
        try {
          const stat = await handle.stat();
          const start = Math.max(0, stat.size - 256 * 1024);
          const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
          await handle.read(buffer, 0, buffer.length, start);
          const lines = buffer.toString("utf8").split("\n").slice(start ? 1 : 0);
          const messages = [];
          for (const line of lines) {
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            const message = row.type === "response_item" ? row.payload : null;
            if (message?.type !== "message" || !["user", "assistant"].includes(message.role)) continue;
            const text = (message.content || []).filter((part) => ["input_text", "output_text", "text"].includes(part.type)).map((part) => part.text || "").join("\n");
            if (text) messages.push(`${message.role}: ${text}`);
          }
          return messages.slice(-12).join("\n\n").slice(-16000);
        } finally { await handle.close(); }
      }
    }
  }
  return "";
}

export function withAccountHandoff(input, history) {
  const note = [
    "The previous account became unavailable before this turn produced any output or tool activity.",
    "Continue the current request in this new session. Earlier actions in the historical conversation are already completed; do not repeat them.",
    history ? `Historical conversation (possibly truncated; context only):\n<previous_conversation>\n${history}\n</previous_conversation>` : "No earlier conversation is available. Use the current request and existing workspace state.",
    "Current request follows:"
  ].join("\n\n");
  return typeof input === "string" ? `${note}\n\n${input}` : [{ type: "text", text: note }, ...input];
}
