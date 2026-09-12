import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { applyCodexStreamEvent, codexStreamResult, createCodexStreamState } from "./stream.js";
import { codexEventError } from "../accounts/errors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export function createAppServerThread({
  threadId = "",
  threadOptions = {},
  codexPath = "codex",
  codexEnv = null,
  codexAuthFileStore = false,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
} = {}) {
  return {
    transport: "app-server-direct",
    id: String(threadId || ""),
    threadOptions,
    codexPath,
    codexEnv,
    codexAuthFileStore,
    connectTimeoutMs,
    async run(input, turnOptions = {}) {
      const { events } = await this.runStreamed(input, turnOptions);
      const streamState = createCodexStreamState();
      for await (const event of events) {
        const update = applyCodexStreamEvent(streamState, event);
        if (update.type === "error") throw new Error(update.message);
      }
      return codexStreamResult(streamState);
    },
    async runStreamed(input, turnOptions = {}) {
      return runAppServerThreadStreamed(this, input, turnOptions);
    }
  };
}

export async function readAppServerThread({
  threadId,
  codexPath = "codex",
  codexEnv = null,
  codexAuthFileStore = false,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  includeTurns = true
} = {}) {
  if (!threadId) throw new Error("threadId is required for app-server thread/read.");
  const client = await connectAppServer({ codexPath, codexEnv, codexAuthFileStore, connectTimeoutMs });
  try {
    return await client.request("thread/read", { threadId, includeTurns });
  } finally {
    await client.close();
  }
}

export function appServerThreadReadEvents(response, { threadId = "", turnId = "" } = {}) {
  const thread = response?.thread || {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const selectedTurn = turnId
    ? turns.find((turn) => turn.id === turnId)
    : [...turns].reverse().find((turn) => turn.status === "completed" || turn.status === "failed") || turns.at(-1);
  if (!selectedTurn) return [];
  const resolvedThreadId = threadId || thread.id || "";
  const events = [];
  for (const item of selectedTurn.items || []) {
    events.push({
      method: "item/completed",
      params: {
        threadId: resolvedThreadId,
        turnId: selectedTurn.id,
        item
      }
    });
  }
  events.push({
    method: "turn/completed",
    params: {
      threadId: resolvedThreadId,
      turn: selectedTurn
    }
  });
  return events;
}

async function runAppServerThreadStreamed(thread, input, turnOptions = {}) {
  const client = await connectAppServer(thread);
  const queue = createAsyncQueue((error) => {
    if (error) { client.fail(error); client.close(); }
  });
  let activeTurnId = "";
  let terminalError;
  const pending = [];
  const unsubscribeError = client.onError((error) => {
    if (!client.closed) queue.fail(error);
  });
  const enqueue = (notification) => {
    const error = codexEventError(notification);
    if (error && !error.willRetry) terminalError = error;
    queue.push(notification);
    if (notification.method === "turn/completed" || (notification.method === "error" && notification.params?.willRetry !== true)) queue.end();
  };

  const unsubscribe = client.onNotification((notification) => {
    if (!isRelevantNotification(notification, thread.id, activeTurnId)) {
      if (!activeTurnId && notification?.params?.threadId === thread.id) pending.push(notification);
      return;
    }
    enqueue(notification);
  });

  const abort = () => {
    const error = turnOptions.signal?.reason instanceof Error ? turnOptions.signal.reason : new Error("This operation was aborted");
    if (activeTurnId && thread.id) {
      client.request("turn/interrupt", { threadId: thread.id, turnId: activeTurnId }).catch(() => {});
    }
    queue.fail(error);
  };
  if (turnOptions.signal?.aborted) {
    unsubscribe();
    unsubscribeError();
    await client.close();
    throw (turnOptions.signal.reason instanceof Error ? turnOptions.signal.reason : new Error("This operation was aborted"));
  } else {
    turnOptions.signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    const threadResponse = thread.id
      ? await client.request("thread/resume", appServerThreadParams({ ...thread.threadOptions, threadId: thread.id }))
      : await client.request("thread/start", appServerThreadParams(thread.threadOptions));
    thread.id = threadResponse?.thread?.id || thread.id;
    if (thread.id) queue.push({ type: "thread.started", thread_id: thread.id });

    const turnResponse = await client.request("turn/start", appServerTurnParams(thread, input, turnOptions));
    activeTurnId = turnResponse?.turn?.id || "";
    for (const notification of pending.splice(0)) {
      if (isRelevantNotification(notification, thread.id, activeTurnId)) enqueue(notification);
    }
    if (turnResponse?.turn?.status === "completed" || turnResponse?.turn?.status === "failed") {
      for (const event of appServerThreadReadEvents({ thread: { id: thread.id, turns: [turnResponse.turn] } }, { threadId: thread.id, turnId: activeTurnId })) {
        queue.push(event);
      }
      queue.end();
    }
  } catch (error) {
    unsubscribe();
    unsubscribeError();
    turnOptions.signal?.removeEventListener("abort", abort);
    await client.close();
    throw terminalError || error;
  }

  return {
    events: wrapQueue(queue, async () => {
      unsubscribe();
      unsubscribeError();
      turnOptions.signal?.removeEventListener("abort", abort);
      await client.close();
    })
  };
}

export async function connectAppServer({ codexPath = "codex", codexEnv = null, codexAuthFileStore = false, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const args = appServerDirectArgs();
  if (codexAuthFileStore) args.push("-c", 'cli_auth_credentials_store="file"', "-c", 'model_provider="openai"');
  const child = spawn(codexPath, args, {
    env: codexAuthFileStore ? codexEnv : mergedEnv(codexEnv),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = new JsonRpcClient(child, { requestTimeoutMs: Math.max(connectTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS) });
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "codex-telegram-bot",
        title: "Codex Telegram Bot",
        version: "0.0.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    client.notify("initialized", {});
  } catch (error) { await client.close(); throw error; }
  return client;
}

export function appServerDirectArgs() {
  return ["app-server", "--stdio"];
}

function appServerThreadParams(options = {}) {
  return compactObject({
    threadId: options.threadId,
    model: options.model || null,
    serviceTier: options.serviceTier || null,
    cwd: options.workingDirectory || null,
    approvalPolicy: options.approvalPolicy || null,
    sandbox: options.sandboxMode || null,
    config: options.codexConfig || null,
    developerInstructions: options.developerInstructions || null
  });
}

function appServerTurnParams(thread, input, turnOptions = {}) {
  return compactObject({
    threadId: thread.id,
    input: appServerInput(input),
    cwd: thread.threadOptions?.workingDirectory || null,
    approvalPolicy: thread.threadOptions?.approvalPolicy || null,
    model: thread.threadOptions?.model || null,
    serviceTier: thread.threadOptions?.serviceTier || null,
    effort: thread.threadOptions?.modelReasoningEffort || null,
    outputSchema: turnOptions.outputSchema || null
  });
}

function appServerInput(input) {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  if (!Array.isArray(input)) return [{ type: "text", text: String(input || ""), text_elements: [] }];
  return input.map((part) => {
    if (part?.type === "text") return { type: "text", text: part.text || "", text_elements: [] };
    if (part?.type === "local_image") return { type: "localImage", path: part.path };
    return part;
  });
}

function isRelevantNotification(notification, threadId, turnId) {
  if (!notification?.method) return false;
  if (notification.method === "thread/started") return !threadId || notification.params?.thread?.id === threadId || notification.params?.threadId === threadId;
  if (notification.method === "error") return true;
  if (!threadId || notification.params?.threadId !== threadId) return false;
  if (!turnId) return false;
  return !notification.params?.turnId || notification.params.turnId === turnId || notification.params?.turn?.id === turnId;
}

class JsonRpcClient {
  constructor(child, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.errorHandlers = new Set();
    this.stderr = "";
    this.closed = false;
    this.exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });

    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdin.on("error", (error) => { if (!this.closed) this.fail(error); });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.fail(new Error(`Codex app-server direct process exited (${signal || (code ?? "unknown")}).${this.stderr ? ` ${this.stderr.trim()}` : ""}`));
    });
  }

  request(method, params = {}) {
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new Error("Codex app-server connection closed."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write(payload); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || "Codex request failed."), { code: message.error.code, codexErrorInfo: message.error.data?.codexErrorInfo }));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.notificationHandlers) handler(message);
  }

  write(payload) {
    if (this.closed) throw new Error("Codex app-server direct process is closed.");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const handler of this.errorHandlers) handler(error);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.fail(new Error("Codex app-server connection closed."));
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref?.();
    this.closePromise = this.exited.finally(() => clearTimeout(timer));
    return this.closePromise;
  }
}

function createAsyncQueue(onClose) {
  const values = [];
  const waiters = [];
  let done = false;
  let failure = null;
  return {
    push(value) {
      if (done || failure) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end() {
      if (done) return;
      done = true;
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
      onClose?.();
    },
    fail(error) {
      if (failure) return;
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      onClose?.(error);
    },
    async next() {
      if (values.length > 0) return { value: values.shift(), done: false };
      if (failure) throw failure;
      if (done) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}

async function* wrapQueue(queue, cleanup) {
  try {
    for await (const event of queue) yield event;
  } finally {
    await cleanup();
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ""));
}

function mergedEnv(env) {
  return env && typeof env === "object" ? { ...process.env, ...env } : process.env;
}
