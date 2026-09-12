import fs from "node:fs/promises";
import path from "node:path";
import { connectAppServer } from "../codex/app_server.js";
import { accountConfig } from "../accounts/context.js";
import { readSessionRequest, sessionTitle } from "./session_labels.js";

export function createWorkspaceBackend(config, { connect = connectAppServer } = {}) {
  async function using(accountId, action) {
    const client = await connect(accountConfig(config, accountId));
    try { return await action(client); } finally { await client.close(); }
  }
  async function listSessions(accountId, { cursor = null, query = "", cwd = null } = {}) {
    const result = await using(accountId, (c) => c.request("thread/list", {
      limit: 8, cursor, sortKey: "updated_at", sortDirection: "desc", searchTerm: query || null, cwd,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]
    }));
    return { ...result, data: await Promise.all((result.data || []).map((s) => describeSession(accountId, s))) };
  }
  async function describeSession(accountId, session) {
    const request = session.name?.trim() ? "" : await readSessionRequest(session.path, accountConfig(config, accountId).codexSessionsDir).catch(() => "");
    return { ...session, displayTitle: sessionTitle(session, request) };
  }
  async function readSession(accountId, id) {
    const session = await using(accountId, async (c) => (await c.request("thread/read", { threadId: id, includeTurns: false })).thread);
    return describeSession(accountId, session);
  }
  async function readMcp(accountId, cwd, health = false) {
    return using(accountId, async (c) => {
      const startupErrors = new Map();
      c.onNotification?.((event) => {
        if (event.method === "mcpServer/startupStatus/updated" && event.params?.error) {
          startupErrors.set(event.params.name, String(event.params.error).slice(0, 800));
        }
      });
      const response = await c.request("config/read", { cwd, includeLayers: true });
      const configured = response.config?.mcp_servers || {};
      const userFile = path.join(accountConfig(config, accountId).codexHome, "config.toml");
      const layer = response.layers?.find((l) => l.name?.type === "user" && !l.name.profile && l.name.file === userFile);
      const rows = Object.entries(configured).map(([name, value]) => ({ name, enabled: value.enabled !== false,
        transport: value.url ? "http" : "stdio", status: value.enabled === false ? "disabled" : "notStarted", tools: null }));
      let threadId;
      if (health) {
        try {
          const started = await c.request("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
          threadId = started.thread.id;
          let cursor = null;
          const seen = new Set();
          do {
            const page = await c.request("mcpServerStatus/list", { threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" });
            for (const server of page.data || []) {
              let row = rows.find((s) => s.name === server.name);
              if (!row) { row = { name: server.name, enabled: true, transport: "plugin", plugin: true }; rows.push(row); }
              Object.assign(row, { status: server.runtimeStatus || "unknown", auth: server.authStatus,
                tools: Object.keys(server.tools || {}).length, error: startupErrors.get(server.name) || "" });
            }
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error("Repeated MCP pagination cursor.");
            seen.add(cursor);
          } while (cursor);
        } finally {
          if (threadId) await c.request("thread/unsubscribe", { threadId }).catch(() => {});
        }
      }
      return { rows, version: layer?.version || null, file: userFile, checked: health };
    });
  }
  async function setMcpEnabled(accountId, cwd, name, enabled, expectedVersion) {
    return using(accountId, async (c) => {
      const before = await c.request("config/read", { cwd, includeLayers: true });
      if (!Object.hasOwn(before.config?.mcp_servers || {}, name)) throw new Error("MCP server no longer exists. Refresh the menu.");
      const result = await c.request("config/value/write", {
        keyPath: `mcp_servers.${JSON.stringify(name)}.enabled`, value: enabled, mergeStrategy: "replace",
        filePath: path.join(accountConfig(config, accountId).codexHome, "config.toml"), expectedVersion
      });
      await c.request("config/mcpServer/reload", {});
      const after = await c.request("config/read", { cwd, includeLayers: false });
      if ((after.config?.mcp_servers?.[name]?.enabled !== false) !== enabled || result.status === "okOverridden") {
        throw new Error("Saved, but a higher-priority configuration overrides this setting.");
      }
      return result;
    });
  }
  return { listSessions, readSession, readMcp, setMcpEnabled };
}

// Only display text messages. Never expose image data, hidden reasoning, or raw tool results.
export async function readSessionTail(file, sessionsDir, { maxBytes = 256 * 1024 } = {}) {
  if (!file) return { messages: [], activity: "unknown" };
  const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(sessionsDir)]);
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !real.endsWith(".jsonl")) throw new Error("Session log is outside this account's session directory.");
  const handle = await fs.open(real, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (size > length) lines.shift();
    const messages = [];
    let activity = "unknown";
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload;
      if (row.type === "event_msg") {
        if (p?.type === "task_started") activity = "running";
        if (["task_complete", "turn_aborted", "task_failed"].includes(p?.type)) activity = "idle";
      }
      if (row.type !== "response_item" || p?.type !== "message" || !["user", "assistant"].includes(p.role)
        || (p.role === "assistant" && p.channel && !["final", "commentary"].includes(p.channel))) continue;
      const text = (p.content || []).filter((v) => ["input_text", "output_text", "text"].includes(v.type))
        .map((v) => v.text || "").join("\n");
      if (text) messages.push({ role: p.role, text: text.slice(-1000) });
    }
    return { messages: messages.slice(-4), activity };
  } finally { await handle.close(); }
}
