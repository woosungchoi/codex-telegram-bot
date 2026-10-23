import path from "node:path";
import {
  parseCodexAnswerFormat,
  parseLanguage,
  parseLiveProgressDeletePolicy,
  parseLiveProgressSource,
  parseLocale,
  parseNonnegativeInteger,
  parseOptionalBoolean,
  parseTelegramIdCsv,
  parseTimeZone
} from "./parsers.js";

export function readTelegramAccessConfig(env) {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken || telegramBotToken.includes("replace_me")) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set it.");
  }

  const allowedUserIds = new Set(parseTelegramIdCsv(env.ALLOWED_USER_IDS, "ALLOWED_USER_IDS"));
  if (allowedUserIds.size === 0) throw new Error("ALLOWED_USER_IDS is required.");
  const allowedChatIds = new Set(parseTelegramIdCsv(env.ALLOWED_CHAT_IDS, "ALLOWED_CHAT_IDS", { allowNegative: true }));
  const allowedThreadIds = new Set(parseTelegramIdCsv(env.ALLOWED_THREAD_IDS, "ALLOWED_THREAD_IDS"));
  const allowedTopicBindings = new Set();
  if (env.ALLOWED_TOPIC_BINDINGS?.trim()) {
    const pairs = JSON.parse(env.ALLOWED_TOPIC_BINDINGS);
    if (!Array.isArray(pairs)) throw new Error("ALLOWED_TOPIC_BINDINGS must be a JSON array of [chatId, topicId] pairs.");
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !/^-?[1-9]\d*$/.test(String(pair[0]))
        || !/^[1-9]\d*$/.test(String(pair[1]))) throw new Error("Invalid ALLOWED_TOPIC_BINDINGS pair.");
      allowedTopicBindings.add(JSON.stringify(pair.map(String)));
    }
  }
  if (allowedThreadIds.size && (allowedChatIds.size !== 1 || allowedTopicBindings.size)) {
    throw new Error("Legacy ALLOWED_THREAD_IDS requires exactly one ALLOWED_CHAT_IDS entry and no ALLOWED_TOPIC_BINDINGS. Configure explicit chat/topic pairs.");
  }
  if (allowedThreadIds.size) console.warn("ALLOWED_THREAD_IDS is bound to the single allowed chat; migrate to ALLOWED_TOPIC_BINDINGS.");
  return {
    telegramBotToken,
    allowedUserIds,
    allowedChatIds, allowedThreadIds, allowedTopicBindings
  };
}

export function readTelegramPreferencesConfig(env) {
  return {
    telegramLanguage: parseLanguage(env.TELEGRAM_LANGUAGE),
    telegramTimeZone: parseTimeZone(env.TELEGRAM_TIME_ZONE),
    telegramLocale: parseLocale(env.TELEGRAM_LOCALE)
  };
}

export function readTelegramRuntimeConfig(env) {
  const operationalStatusFile = env.OPERATIONAL_STATUS_FILE?.trim() || "";
  if (operationalStatusFile && !path.isAbsolute(operationalStatusFile)) {
    throw new Error("OPERATIONAL_STATUS_FILE must be an absolute path.");
  }
  return {
    operationalStatusFile,
    maxTelegramChars: parseNonnegativeInteger(env.MAX_TELEGRAM_CHARS, 3500, "MAX_TELEGRAM_CHARS"),
    progressEditIntervalMs: parseNonnegativeInteger(env.PROGRESS_EDIT_INTERVAL_MS, 8000, "PROGRESS_EDIT_INTERVAL_MS"),
    telegramReactionsEnabled: parseOptionalBoolean(env.TELEGRAM_REACTIONS_ENABLED) ?? true,
    telegramThinkingReaction: env.TELEGRAM_THINKING_REACTION?.trim() || "🤔",
    telegramCompleteReaction: env.TELEGRAM_COMPLETE_REACTION?.trim() || "👌",
    telegramErrorReaction: env.TELEGRAM_ERROR_REACTION?.trim() || "😢",
    telegramStoppedReaction: env.TELEGRAM_STOPPED_REACTION?.trim() || "😴",
    telegramFormatCodexAnswers: parseCodexAnswerFormat(env.TELEGRAM_FORMAT_CODEX_ANSWERS),
    telegramCompletionNoticeSeconds: parseNonnegativeInteger(
      env.TELEGRAM_COMPLETION_NOTICE_SECONDS,
      90,
      "TELEGRAM_COMPLETION_NOTICE_SECONDS"
    ),
    telegramPendingTurnsMax: parseNonnegativeInteger(
      env.TELEGRAM_PENDING_TURNS_MAX,
      10,
      "TELEGRAM_PENDING_TURNS_MAX"
    ),
    telegramPendingTurnMaxAgeSeconds: parseNonnegativeInteger(
      env.TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS,
      7200,
      "TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS"
    ),
    telegramLiveProgressEnabled: parseOptionalBoolean(env.TELEGRAM_LIVE_PROGRESS_ENABLED) ?? true,
    telegramLiveProgressIntervalMs: parseNonnegativeInteger(
      env.TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS,
      30,
      "TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS"
    ) * 1000,
    telegramLiveProgressMode: env.TELEGRAM_LIVE_PROGRESS_MODE?.trim() || "brief",
    telegramLiveProgressSource: parseLiveProgressSource(env.TELEGRAM_LIVE_PROGRESS_SOURCE),
    telegramLiveProgressDeletePolicy: parseLiveProgressDeletePolicy(
      env.TELEGRAM_LIVE_PROGRESS_DELETE_POLICY
    )
  };
}
