export function createCodexStreamState() {
  return {
    items: new Map(),
    nextSyntheticItemId: 1,
    finalResponse: "",
    usage: null
  };
}

export function applyCodexStreamEvent(state, event) {
  const normalized = normalizeCodexStreamEvent(state, event);
  if (normalized !== event) return applyCodexStreamEvent(state, normalized);

  if (event.type === "thread.started") {
    return { type: "thread_started", threadId: event.thread_id };
  }
  if (event.type === "turn.started") {
    return { type: "turn_started" };
  }
  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    state.items.set(event.item.id, event.item);
    const previousFinalResponse = state.finalResponse;
    if (event.item.type === "agent_message") state.finalResponse = event.item.text;
    return {
      type: "item",
      item: event.item,
      eventType: event.type,
      finalResponseChanged: state.finalResponse !== previousFinalResponse
    };
  }
  if (event.type === "turn.completed") {
    state.usage = event.usage;
    return { type: "turn_completed", usage: event.usage ?? null };
  }
  if (event.type === "turn.failed") {
    return { type: "error", message: errorMessage(event.error, "Codex turn failed.") };
  }
  if (event.type === "error") {
    return { type: "error", message: errorMessage(event, "Codex stream error.") };
  }
  return { type: "unknown", eventType: event?.type || "unknown" };
}

export function codexStreamItems(state) {
  return [...state.items.values()];
}

export function codexStreamResult(state) {
  return {
    items: codexStreamItems(state),
    finalResponse: state.finalResponse,
    usage: state.usage
  };
}

export function normalizeCodexStreamEvent(state, event) {
  if (!event || typeof event !== "object") return event;

  if (event.type === "response_item" && event.payload?.type === "message") {
    return {
      type: "item.completed",
      item: {
        id: streamItemId(state, event.payload),
        type: "agent_message",
        text: extractMessageText(event.payload)
      }
    };
  }

  if (event.type === "event_msg") {
    const payload = event.payload ?? {};
    if (payload.type === "agent_message") {
      return {
        type: "item.completed",
        item: {
          id: streamItemId(state, payload),
          type: "agent_message",
          text: extractMessageText(payload)
        }
      };
    }
    if (payload.type === "task_complete") return { type: "turn.completed", usage: payload.usage ?? null };
    if (payload.type === "task_failed") return { type: "turn.failed", error: { message: errorMessage(payload, "Codex task failed.") } };
  }

  return event;
}

export function extractMessageText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.message === "string") return message.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).filter(Boolean).join("");
  }
  return "";
}

function streamItemId(state, payload) {
  if (payload.id) return String(payload.id);
  const next = state.nextSyntheticItemId ?? 1;
  state.nextSyntheticItemId = next + 1;
  return `stream-message-${next}`;
}

function errorMessage(error, fallback) {
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof error?.error === "string" && error.error.trim()) return error.error;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
