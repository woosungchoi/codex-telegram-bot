export function createCodexStreamState() {
  return {
    items: new Map(),
    appServerAgentMessageTextById: new Map(),
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
    const message = errorMessage(event, "Codex stream error.");
    if (isReconnectNotice(message)) return { type: "reconnecting", message };
    return { type: "error", message };
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

  if (event.method) return normalizeAppServerNotification(state, event);

  if (event.type === "response_item" && event.payload?.type === "message" && isAssistantMessage(event.payload)) {
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

function normalizeAppServerNotification(state, notification) {
  const { method, params = {} } = notification;
  if (method === "thread/started") {
    return { type: "thread.started", thread_id: params.threadId || params.thread?.id };
  }
  if (method === "turn/started") return { type: "turn.started", turn_id: params.turnId || params.turn?.id };
  if (method === "item/started") return { type: "item.started", item: normalizeAppServerItem(params.item) };
  if (method === "item/completed") return { type: "item.completed", item: normalizeAppServerItem(params.item) };
  if (method === "rawResponseItem/completed" && params.item?.type === "message" && isAssistantMessage(params.item)) {
    return {
      type: "item.completed",
      item: {
        id: streamItemId(state, params.item),
        type: "agent_message",
        text: extractMessageText(params.item)
      }
    };
  }
  if (method === "item/agentMessage/delta") {
    const itemId = String(params.itemId || streamItemId(state, params));
    const previous = state.appServerAgentMessageTextById.get(itemId) || "";
    const text = `${previous}${params.delta || ""}`;
    state.appServerAgentMessageTextById.set(itemId, text);
    return {
      type: "item.updated",
      item: {
        id: itemId,
        type: "agent_message",
        text
      }
    };
  }
  if (method === "turn/completed") {
    if (params.turn?.status === "failed") {
      return { type: "turn.failed", error: params.turn?.error || { message: "Codex app-server turn failed." } };
    }
    return { type: "turn.completed", usage: params.usage ?? null };
  }
  if (method === "error") return { type: "error", message: errorMessage(params, "Codex app-server error.") };
  return notification;
}

function normalizeAppServerItem(item = {}) {
  const type = normalizeAppServerItemType(item.type);
  const normalized = { ...item, type };
  if (type === "agent_message") normalized.text = extractMessageText(item);
  if (type === "command_execution") normalized.text = item.aggregatedOutput || item.command || "";
  if (type === "reasoning" && !normalized.text) normalized.text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
  return normalized;
}

function normalizeAppServerItemType(type) {
  const map = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    dynamicToolCall: "dynamic_tool_call",
    userMessage: "user_message",
    hookPrompt: "hook_prompt",
    subAgentActivity: "sub_agent_activity",
    webSearch: "web_search",
    imageView: "image_view",
    imageGeneration: "image_generation",
    enteredReviewMode: "entered_review_mode",
    exitedReviewMode: "exited_review_mode",
    contextCompaction: "context_compaction"
  };
  return map[type] || type || "unknown";
}

function isAssistantMessage(message) {
  return !message.role || message.role === "assistant";
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

function isReconnectNotice(message) {
  return /^Reconnecting\.\.\. \d+\/\d+ \(stream disconnected before completion: .+\)$/.test(message);
}
