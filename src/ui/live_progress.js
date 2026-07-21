import { code, stripHtml } from "../telegram/html.js";
import { runTelegramProgressBestEffort } from "../telegram/api.js";
import {
  formatCodexAnswerMarkdownHtml,
  formatCodexAnswerSafeHtml
} from "../telegram/markdown.js";

export function createLiveProgressController({
  settings,
  options,
  telegram,
  recovery,
  localization,
  formatting,
  logger = console,
  now = Date.now
}) {
  function formatTurn(turn) {
    return turn.finalResponse?.trim() || "";
  }

  function summarizeProgress(items) {
    const latest = items.at(-1);
    const counts = countBy(items, (item) => item.type);
    const parts = ["Codex progress"];
    if (counts.reasoning) parts.push(`reasoning:${counts.reasoning}`);
    if (counts.command_execution) parts.push(`cmd:${counts.command_execution}`);
    if (counts.file_change) parts.push(`files:${counts.file_change}`);
    if (counts.web_search) parts.push(`web:${counts.web_search}`);
    if (latest?.type === "command_execution") {
      parts.push(`last: ${formatting.truncate(latest.command, 80)}`);
    }
    if (latest?.type === "web_search") {
      parts.push(`last: ${formatting.truncate(latest.query, 80)}`);
    }
    return parts.join("\n");
  }

  function createLiveProgressState(active = null) {
    return {
      lastSentAt: 0,
      lastKey: "",
      active,
      chatKey: "",
      messageRefs: []
    };
  }

  function shouldDeleteLiveProgress(progressState, turnSucceeded) {
    const effective = progressState?.chatKey
      ? options.get(progressState.chatKey)
      : options.defaults();
    if (effective.liveProgressDeletePolicy === "never") return false;
    if (effective.liveProgressDeletePolicy === "on_success") return turnSucceeded;
    return true;
  }

  async function maybeSendLiveProgress(ctx, progressState, event, items) {
    if (!progressState) return false;
    const effective = options.get(progressState.chatKey || telegram.getChatKey(ctx));
    if (!effective.liveProgressEnabled) return false;
    if (!["brief", "korean-brief"].includes(settings.runtimeValue("telegramLiveProgressMode"))) {
      return false;
    }
    const progress = buildLiveProgressMessage(
      event,
      items,
      effective.liveProgressSource,
      localization.language()
    );
    if (!progress || progress.key === progressState.lastKey) return false;

    const currentTime = now();
    const intervalMs = Math.max(0, settings.runtimeValue("telegramLiveProgressIntervalMs"));
    if (
      !progress.important
      && progressState.lastSentAt > 0
      && currentTime - progressState.lastSentAt < intervalMs
    ) return false;

    progressState.lastSentAt = currentTime;
    progressState.lastKey = progress.key;
    if (progressState.active) {
      progressState.active.lastProgress = stripHtml(progress.html);
      progressState.active.lastProgressAt = new Date(currentTime).toISOString();
    }
    const result = await runTelegramProgressBestEffort(
      () => telegram.replyTracked(ctx, progressState, progress.html),
      {
        onError: (errorSummary) => recovery.recordProgressFailed(
          progressState,
          event,
          errorSummary
        ),
        logger
      }
    );
    return result.ok;
  }

  function buildLiveProgressMessage(event, items, source = "agent", language = "en") {
    const messages = [];
    if (source === "agent" || source === "both") {
      const agentMessage = buildAgentLiveProgressMessage(event);
      if (agentMessage) messages.push(agentMessage);
    }
    if (source === "activity" || source === "both") {
      const activityMessage = buildActivityLiveProgressMessage(event, items, language);
      if (activityMessage) messages.push(activityMessage);
    }
    if (messages.length === 0) return null;
    if (source !== "both" || messages.length === 1) return messages[0];
    return {
      key: messages.map((message) => message.key).join("|"),
      html: messages.map((message) => message.html).join("\n\n"),
      important: messages.some((message) => message.important)
    };
  }

  function buildAgentLiveProgressMessage(event) {
    if (!isItemEvent(event.type)) return null;
    const item = event.item;
    if (item?.type !== "agent_message") return null;
    const text = String(item.text || "").trim();
    if (!text) return null;
    return {
      key: `agent-message-${item.id}-${hashString(text)}`,
      html: formatLiveAgentMessageHtml(text),
      important: event.type === "item.completed"
    };
  }

  function buildActivityLiveProgressMessage(event, items, language = "en") {
    if (event.type === "turn.started") {
      return { key: "turn-started", html: localization.forLanguage(language, "liveTurnStarted"), important: true };
    }
    if (event.type === "turn.completed") {
      return { key: "turn-completed", html: localization.forLanguage(language, "liveTurnCompleted"), important: true };
    }
    if (!isItemEvent(event.type)) return null;

    const item = event.item;
    if (!item) return null;
    if (item.type === "reasoning") {
      return { key: "reasoning", html: localization.forLanguage(language, "liveReasoning"), important: false };
    }
    if (item.type === "todo_list") {
      const remaining = item.items?.filter((todo) => !todo.completed).length ?? 0;
      return {
        key: `todo-${remaining}`,
        html: remaining > 0
          ? localization.formatForLanguage(language, "liveTodoRemaining", { remaining: code(remaining) })
          : localization.forLanguage(language, "liveTodoOrganizing"),
        important: false
      };
    }
    if (item.type === "command_execution") {
      const command = shortCommand(item.command || "");
      if (item.status === "failed") {
        return activity(`cmd-failed-${item.id}`, "liveCommandFailed", language, { command: code(command) }, true);
      }
      if (item.status === "completed") {
        return activity(`cmd-done-${item.id}`, "liveCommandFinished", language, { command: code(command) });
      }
      return activity(`cmd-running-${item.id}`, "liveCommandRunning", language, { command: code(command) });
    }
    if (item.type === "file_change") {
      const paths = summarizeFileChangePaths(item);
      if (item.status === "failed") {
        return activity(`file-failed-${item.id}`, "liveFileFailed", language, {}, true);
      }
      return activity(`file-done-${item.id}`, "liveFileUpdated", language, {
        paths: code(paths || localization.forLanguage(language, "liveChangedFiles"))
      }, true);
    }
    if (item.type === "mcp_tool_call") {
      const tool = shortToolName(item);
      if (item.status === "failed") {
        return activity(`tool-failed-${item.id}`, "liveToolFailed", language, { tool: code(tool) }, true);
      }
      if (item.status === "completed") {
        return activity(`tool-done-${item.id}`, "liveToolFinished", language, { tool: code(tool) });
      }
      return activity(`tool-running-${item.id}`, "liveToolRunning", language, { tool: code(tool) });
    }
    if (item.type === "web_search") {
      return event.type === "item.completed"
        ? activity(`web-done-${item.id}`, "liveWebFinished", language)
        : activity(`web-running-${item.id}`, "liveWebRunning", language);
    }
    if (item.type === "error") {
      return activity(`item-error-${item.id}`, "liveItemError", language, {}, true);
    }
    if (item.type === "agent_message" && event.type !== "item.completed") {
      return activity("agent-message-draft", "liveAgentDraft", language);
    }
    return null;
  }

  function activity(key, textKey, language, values = {}, important = false) {
    return {
      key,
      html: Object.keys(values).length > 0
        ? localization.formatForLanguage(language, textKey, values)
        : localization.forLanguage(language, textKey),
      important
    };
  }

  function formatLiveAgentMessageHtml(text) {
    const max = Math.min(Math.max(500, settings.runtimeValue("maxTelegramChars")), 2000);
    const body = formatting.truncate(text.trim(), max);
    return settings.runtimeValue("telegramFormatCodexAnswers") === "markdown"
      ? formatCodexAnswerMarkdownHtml(body)
      : formatCodexAnswerSafeHtml(body);
  }

  function shortCommand(command) {
    const redacted = formatting.redact(String(command || "").replace(/\s+/g, " ").trim());
    return formatting.truncate(redacted || "command", 90);
  }

  function shortToolName(item) {
    return formatting.truncate([item.server, item.tool].filter(Boolean).join("/") || "tool", 80);
  }

  function summarizeFileChangePaths(item) {
    const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
    if (paths.length === 0) return "";
    const summary = paths.slice(0, 3).join(", ");
    return paths.length > 3 ? `${summary}, +${paths.length - 3}` : summary;
  }

  return {
    buildLiveProgressMessage,
    createLiveProgressState,
    formatTurn,
    maybeSendLiveProgress,
    shouldDeleteLiveProgress,
    summarizeProgress
  };
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) counts[getKey(value)] = (counts[getKey(value)] ?? 0) + 1;
  return counts;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function isItemEvent(type) {
  return type === "item.started" || type === "item.updated" || type === "item.completed";
}
