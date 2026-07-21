import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { code } from "../telegram/html.js";
import { createWorkerClient } from "../worker/client.js";
import {
  createCodexThread as createCodexThreadForTransport,
  threadTransport as detectThreadTransport
} from "./thread_factory.js";

export function createCodexSessionRuntime({
  settings,
  activeTurns,
  threadCache,
  codexClients,
  chats,
  persistence,
  telegram
}) {
  let workerClient = null;

  function codexTransport() {
    return settings.runtimeValue("codexTransport");
  }

  function codexWorkerMode() {
    return settings.runtimeValue("codexWorkerMode");
  }

  function useWorkerSidecar() {
    return codexWorkerMode() === "sidecar";
  }

  function getWorkerClient() {
    if (!workerClient) workerClient = createWorkerClient(settings.config);
    return workerClient;
  }

  function startCodexThread(chatKey) {
    return createCodexThread(chatKey, "");
  }

  function resumeCodexThread(chatKey, threadId) {
    return createCodexThread(chatKey, threadId);
  }

  function createCodexThread(chatKey, threadId = "") {
    return createCodexThreadForTransport({
      transport: codexTransport(),
      threadId,
      effectiveOptions: chats.getEffectiveOptions(chatKey),
      config: {
        ...settings.config,
        codexAppServerDirectTimeoutMs: settings.runtimeValue("codexAppServerDirectTimeoutMs")
      },
      codexClients
    });
  }

  function threadTransport(thread) {
    return detectThreadTransport(thread);
  }

  function getOrCreateThread(chatKey) {
    const cached = threadCache.get(chatKey);
    if (cached && threadTransport(cached) === codexTransport()) return cached;
    if (cached) threadCache.delete(chatKey);

    const savedThreadId = chats.get(chatKey).threadId;
    const thread = savedThreadId
      ? resumeCodexThread(chatKey, savedThreadId)
      : startCodexThread(chatKey);
    threadCache.set(chatKey, thread);
    return thread;
  }

  async function rememberThread(chatKey, thread) {
    if (!thread.id) return;
    const chat = chats.get(chatKey);
    chat.threadId = thread.id;
    chat.updatedAt = new Date().toISOString();
    await persistence.save();
  }

  async function rejectIfActive(ctx, chatKey) {
    if (!activeTurns.has(chatKey)) return false;
    await telegram.replyHtml(
      ctx,
      `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`
    );
    return true;
  }

  function isStatusQuestion(text) {
    const normalized = String(text || "").trim().toLowerCase();
    if (normalized.length > 80) return false;
    return [
      "status",
      "progress",
      "queue",
      "뭐해",
      "뭐 하는",
      "뭐하고",
      "진행",
      "상태",
      "멈췄",
      "멈춘",
      "어디까지",
      "작업 중",
      "작업중",
      "하고 있어",
      "진행중"
    ].some((keyword) => normalized.includes(keyword));
  }

  async function ensureDirectory(dir, label) {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
  }

  async function listRecentCodexSessions(limit) {
    let files = [];
    try {
      files = await listFiles(settings.config.codexSessionsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const sessions = [];
    for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort().reverse()) {
      const meta = await readSessionMeta(file);
      if (meta) sessions.push(meta);
      if (sessions.length >= Math.max(limit, 20)) break;
    }
    return sessions
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, limit);
  }

  async function listFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await listFiles(fullPath));
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  async function readSessionMeta(file) {
    try {
      const parsed = JSON.parse(await readFirstLine(file));
      if (parsed?.type !== "session_meta" || !parsed.payload?.id) return null;
      return {
        id: parsed.payload.id,
        timestamp: parsed.payload.timestamp ?? parsed.timestamp ?? "",
        cwd: parsed.payload.cwd ?? "unknown",
        source: parsed.payload.source ?? "unknown",
        originator: parsed.payload.originator ?? "unknown",
        path: file
      };
    } catch {
      return null;
    }
  }

  async function findCodexSessionFile(threadId) {
    if (!threadId) return null;
    let files = [];
    try {
      files = await listFiles(settings.config.codexSessionsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort().reverse()) {
      const meta = await readSessionMeta(file);
      if (meta?.id === threadId) return file;
    }
    return null;
  }

  return {
    codexTransport,
    codexWorkerMode,
    createCodexThread,
    ensureDirectory,
    findCodexSessionFile,
    getOrCreateThread,
    getWorkerClient,
    isStatusQuestion,
    listFiles,
    listRecentCodexSessions,
    readSessionMeta,
    rejectIfActive,
    rememberThread,
    resumeCodexThread,
    startCodexThread,
    threadTransport,
    useWorkerSidecar
  };
}

function readFirstLine(file) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: "utf8" });
    let buffer = "";
    let settled = false;
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        settled = true;
        resolve(buffer.slice(0, newlineIndex));
        stream.destroy();
      }
    });
    stream.on("error", reject);
    stream.on("close", () => {
      if (!settled) resolve(buffer);
    });
  });
}
