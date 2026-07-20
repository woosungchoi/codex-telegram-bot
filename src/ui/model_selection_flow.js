import { randomBytes } from "node:crypto";

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{6}$/;

export function createSelectionFlowStore({
  now = () => Date.now(),
  tokenFactory = () => randomBytes(3).toString("hex"),
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const sessions = new Map();
  const activeByChat = new Map();

  function begin(chatKey, kind, initial = {}) {
    pruneExpired();
    const previousToken = activeByChat.get(chatKey);
    if (previousToken) sessions.delete(previousToken);

    const token = nextToken();
    const timestamp = now();
    const session = {
      modelChoice: "",
      modelSlug: "",
      reasoningChoice: "",
      fastSupported: false,
      ...initial,
      token,
      chatKey,
      kind,
      phase: kind === "model" ? "model" : "reasoning",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    sessions.set(token, session);
    activeByChat.set(chatKey, token);
    return { ...session };
  }

  function read(chatKey, token) {
    pruneExpired();
    if (activeByChat.get(chatKey) !== token) return null;
    const session = sessions.get(token);
    return session?.chatKey === chatKey ? { ...session } : null;
  }

  function update(chatKey, token, expectedPhase, patch) {
    const current = read(chatKey, token);
    if (!current || current.phase !== expectedPhase) return null;
    const session = {
      ...current,
      ...patch,
      token: current.token,
      chatKey: current.chatKey,
      kind: current.kind,
      createdAt: current.createdAt,
      updatedAt: now()
    };
    sessions.set(token, session);
    return { ...session };
  }

  function finish(chatKey, token, expectedPhase) {
    const current = read(chatKey, token);
    if (!current || (expectedPhase && current.phase !== expectedPhase)) return null;
    sessions.delete(token);
    if (activeByChat.get(chatKey) === token) activeByChat.delete(chatKey);
    return current;
  }

  function size() {
    pruneExpired();
    return sessions.size;
  }

  function pruneExpired() {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (timestamp - session.updatedAt <= maxAgeMs) continue;
      sessions.delete(token);
      if (activeByChat.get(session.chatKey) === token) activeByChat.delete(session.chatKey);
    }
  }

  function nextToken() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const token = String(tokenFactory());
      if (TOKEN_PATTERN.test(token) && !sessions.has(token)) return token;
    }
    throw new Error("Unable to allocate a selection flow token");
  }

  return { begin, read, update, finish, size };
}

export function applyModelSelectionDraft(options, draft) {
  const next = { ...options };
  if (draft.modelChoice === "default") delete next.model;
  else next.model = draft.modelChoice;

  if (draft.reasoningChoice === "default") delete next.modelReasoningEffort;
  else next.modelReasoningEffort = draft.reasoningChoice;

  if (draft.fastSupported) {
    if (draft.fastChoice === "on") next.serviceTier = "fast";
    else if (draft.fastChoice === "off") delete next.serviceTier;
  } else if (next.serviceTier === "fast") {
    delete next.serviceTier;
  }
  return next;
}

export function applyReasoningSelection(options, reasoningChoice) {
  const next = { ...options };
  if (reasoningChoice === "default") delete next.modelReasoningEffort;
  else next.modelReasoningEffort = reasoningChoice;
  return next;
}
