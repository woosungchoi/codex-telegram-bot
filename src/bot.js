import "dotenv/config";

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Codex } from "@openai/codex-sdk";
import MarkdownIt from "markdown-it";
import { Telegraf } from "telegraf";
import { LANGUAGE_CHOICES, TELEGRAM_LANGUAGE_CODES, VALID_LANGUAGES, textFor } from "./i18n.js";
import { isRegisteredTelegramCommandText } from "./telegram_commands.js";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VALID = {
  approval: new Set(["never", "on-request", "on-failure", "untrusted"]),
  sandbox: new Set(["read-only", "workspace-write", "danger-full-access"]),
  reasoning: new Set(["minimal", "low", "medium", "high", "xhigh"]),
  serviceTier: new Set(["fast", "flex"]),
  webSearch: new Set(["disabled", "cached", "live"]),
  queueMode: new Set(["safe", "interrupt", "side"]),
  language: VALID_LANGUAGES,
  liveProgressSource: new Set(["agent", "activity", "both"]),
  liveProgressDeletePolicy: new Set(["always", "on_success", "never"])
};

const UTC_OFFSET_TIME_ZONE_CHOICES = [
  ["utc_m11", "UTC-11", "Etc/GMT+11"],
  ["utc_m10", "UTC-10", "Etc/GMT+10"],
  ["utc_m09", "UTC-09", "Etc/GMT+9"],
  ["utc_m08", "UTC-08", "Etc/GMT+8"],
  ["utc_m07", "UTC-07", "Etc/GMT+7"],
  ["utc_m06", "UTC-06", "Etc/GMT+6"],
  ["utc_m05", "UTC-05", "Etc/GMT+5"],
  ["utc_m04", "UTC-04", "Etc/GMT+4"],
  ["utc_m03", "UTC-03", "Etc/GMT+3"],
  ["utc_m02", "UTC-02", "Etc/GMT+2"],
  ["utc_m01", "UTC-01", "Etc/GMT+1"],
  ["utc", "UTC+00", "UTC"],
  ["utc_p01", "UTC+01", "Etc/GMT-1"],
  ["utc_p02", "UTC+02", "Etc/GMT-2"],
  ["utc_p03", "UTC+03", "Etc/GMT-3"],
  ["utc_p04", "UTC+04", "Etc/GMT-4"],
  ["utc_p05", "UTC+05", "Etc/GMT-5"],
  ["utc_p06", "UTC+06", "Etc/GMT-6"],
  ["utc_p07", "UTC+07", "Etc/GMT-7"],
  ["utc_p08", "UTC+08", "Etc/GMT-8"],
  ["utc_p09", "UTC+09", "Etc/GMT-9"],
  ["utc_p10", "UTC+10", "Etc/GMT-10"],
  ["utc_p11", "UTC+11", "Etc/GMT-11"],
  ["utc_p12", "UTC+12", "Etc/GMT-12"]
];

const REGIONAL_TIME_ZONE_CHOICES = {
  asia: [
    ["asia_seoul", "Seoul", "Asia/Seoul"],
    ["asia_tokyo", "Tokyo", "Asia/Tokyo"],
    ["asia_singapore", "Singapore", "Asia/Singapore"],
    ["asia_shanghai", "Shanghai", "Asia/Shanghai"],
    ["asia_hong_kong", "Hong Kong", "Asia/Hong_Kong"],
    ["asia_taipei", "Taipei", "Asia/Taipei"],
    ["asia_bangkok", "Bangkok", "Asia/Bangkok"],
    ["asia_jakarta", "Jakarta", "Asia/Jakarta"],
    ["asia_kolkata", "India", "Asia/Kolkata"],
    ["asia_dubai", "Dubai", "Asia/Dubai"],
    ["asia_tehran", "Tehran", "Asia/Tehran"]
  ],
  europe: [
    ["europe_london", "London", "Europe/London"],
    ["europe_dublin", "Dublin", "Europe/Dublin"],
    ["europe_lisbon", "Lisbon", "Europe/Lisbon"],
    ["europe_paris", "Paris", "Europe/Paris"],
    ["europe_berlin", "Berlin", "Europe/Berlin"],
    ["europe_madrid", "Madrid", "Europe/Madrid"],
    ["europe_rome", "Rome", "Europe/Rome"],
    ["europe_amsterdam", "Amsterdam", "Europe/Amsterdam"],
    ["europe_stockholm", "Stockholm", "Europe/Stockholm"],
    ["europe_warsaw", "Warsaw", "Europe/Warsaw"],
    ["europe_athens", "Athens", "Europe/Athens"],
    ["europe_istanbul", "Istanbul", "Europe/Istanbul"],
    ["europe_moscow", "Moscow", "Europe/Moscow"]
  ],
  america: [
    ["america_los_angeles", "Los Angeles", "America/Los_Angeles"],
    ["america_vancouver", "Vancouver", "America/Vancouver"],
    ["america_phoenix", "Phoenix", "America/Phoenix"],
    ["america_denver", "Denver", "America/Denver"],
    ["america_chicago", "Chicago", "America/Chicago"],
    ["america_mexico_city", "Mexico City", "America/Mexico_City"],
    ["america_new_york", "New York", "America/New_York"],
    ["america_toronto", "Toronto", "America/Toronto"],
    ["america_bogota", "Bogota", "America/Bogota"],
    ["america_lima", "Lima", "America/Lima"],
    ["america_santiago", "Santiago", "America/Santiago"],
    ["america_buenos_aires", "Buenos Aires", "America/Argentina/Buenos_Aires"],
    ["america_sao_paulo", "Sao Paulo", "America/Sao_Paulo"],
    ["america_anchorage", "Anchorage", "America/Anchorage"]
  ],
  africa: [
    ["africa_casablanca", "Casablanca", "Africa/Casablanca"],
    ["africa_accra", "Accra", "Africa/Accra"],
    ["africa_lagos", "Lagos", "Africa/Lagos"],
    ["africa_tunis", "Tunis", "Africa/Tunis"],
    ["africa_cairo", "Cairo", "Africa/Cairo"],
    ["africa_johannesburg", "Johannesburg", "Africa/Johannesburg"],
    ["africa_nairobi", "Nairobi", "Africa/Nairobi"],
    ["africa_addis_ababa", "Addis Ababa", "Africa/Addis_Ababa"]
  ],
  oceania: [
    ["oceania_perth", "Perth", "Australia/Perth"],
    ["oceania_brisbane", "Brisbane", "Australia/Brisbane"],
    ["oceania_sydney", "Sydney", "Australia/Sydney"],
    ["oceania_melbourne", "Melbourne", "Australia/Melbourne"],
    ["oceania_auckland", "Auckland", "Pacific/Auckland"],
    ["oceania_fiji", "Fiji", "Pacific/Fiji"],
    ["oceania_guam", "Guam", "Pacific/Guam"],
    ["oceania_port_moresby", "Port Moresby", "Pacific/Port_Moresby"],
    ["oceania_honolulu", "Honolulu", "Pacific/Honolulu"]
  ]
};

const TIME_ZONE_GROUPS = [
  ["asia", "🌏", "Asia"],
  ["europe", "🌍", "Europe"],
  ["america", "🌎", "America"],
  ["africa", "🌍", "Africa"],
  ["oceania", "🌊", "Oceania"],
  ["utc", "🕘", "UTC Offset"]
];

const TIME_ZONE_CHOICES = [
  ...UTC_OFFSET_TIME_ZONE_CHOICES,
  ...Object.values(REGIONAL_TIME_ZONE_CHOICES).flat()
];

const LOCALE_CHOICES = [
  ["en_us", "🇺🇸 en-US", "en-US"],
  ["en_gb", "🇬🇧 en-GB", "en-GB"],
  ["ko_kr", "🇰🇷 ko-KR", "ko-KR"]
];

const TIME_PRESET_CHOICES = [
  ["00_00", "00:00"],
  ["03_30", "03:30"],
  ["09_00", "09:00"],
  ["18_00", "18:00"]
];

const DEFAULT_PERSONA_PROMPTS = {
  en: [
    "Response style instructions:",
    "- Always answer in bright, proactive, cheerful English, even after a session reset.",
    "- Use emoji generously, but do not compromise the accuracy of code, commands, paths, or error messages.",
    "- If the user explicitly requests another tone or format, that request takes priority.",
    "- Tone instructions do not override safety, security, accuracy, or the user's requested scope."
  ].join("\n"),
  ko: [
    "응답 스타일 지침:",
    "- 세션이 초기화되어도 항상 밝고, 적극적이며 명랑한 한국어 존댓말로 답합니다.",
    "- 이모지를 풍부하게 사용하되, 코드/명령/경로/오류 메시지의 정확성을 해치지 않습니다.",
    "- 사용자가 다른 톤이나 형식을 명시하면 그 요청을 우선합니다.",
    "- 말투 지침은 안전, 보안, 정확성, 사용자 요청 범위보다 우선하지 않습니다."
  ].join("\n")
};

const FALLBACK_CODEX_MODELS = [
  { slug: "gpt-5.5", displayName: "GPT-5.5", fastSupported: true },
  { slug: "gpt-5.4", displayName: "GPT-5.4", fastSupported: true },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", fastSupported: false },
  { slug: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", fastSupported: false },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", fastSupported: false },
  { slug: "gpt-5.2", displayName: "GPT-5.2", fastSupported: false }
];

const config = readConfig();
const bot = new Telegraf(config.telegramBotToken, { handlerTimeout: Infinity });
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
});

const state = await loadState(config.stateFile);
const threadCache = new Map();
const activeTurns = new Map();
const pendingTurns = new Map();
const codexClients = new Map();
const sideTurns = new Map();

hydratePendingTurnsFromState();

bot.catch(async (error, ctx) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Unhandled Telegram update error:", message);
  if (ctx.chat) {
    await replyHtml(ctx, `${b("Telegram bot error")}\n${code(message)}`).catch(() => {});
  }
});

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id ?? "");
  if (!config.allowedUserIds.has(userId)) {
    if (ctx.message) await ctx.reply("Unauthorized.");
    return;
  }
  return next();
});

bot.start(async (ctx) => {
  await replyHtml(ctx, helpTextHtml());
});

bot.help(async (ctx) => {
  await replyHtml(ctx, helpTextHtml());
});

bot.command("menu", async (ctx) => {
  await sendPanel(ctx, "main");
});

bot.command("new", async (ctx) => {
  await handleNewCommand(ctx);
});

async function handleNewCommand(ctx) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const previousThreadId = getChatState(chatKey).threadId || threadCache.get(chatKey)?.id || "";
  const thread = getCodexClient(chatKey).startThread(buildThreadOptions(chatKey));
  threadCache.set(chatKey, thread);
  const chat = getChatState(chatKey);
  delete chat.threadId;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);

  const abortController = new AbortController();
  activeTurns.set(chatKey, { abortController });
  let finalReaction = "";
  await reactQuietly(ctx, config.telegramThinkingReaction);
  try {
    await runCodexTurn(
      ctx,
      chatKey,
      thread,
      applyPersonaPrompt(uiLanguage() === "ko"
        ? "새 Telegram Codex 세션을 시작합니다. 이 메시지에는 짧게 준비 완료라고만 답하세요."
        : "Start a new Telegram Codex session. Reply only with a short ready confirmation."),
      abortController.signal
    );
    await rememberThread(chatKey, thread);
    await replyHtml(ctx, formatKeyValueHtml("New Codex thread started.", [
      ["Previous thread", previousThreadId || "none"],
      ["New thread", thread.id || "unknown"],
      ["Workdir", getEffectiveOptions(chatKey).workingDirectory]
    ]));
    finalReaction = config.telegramCompleteReaction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalReaction = abortController.signal.aborted ? config.telegramStoppedReaction : config.telegramErrorReaction;
    await replyHtml(ctx, `<b>Failed to start new Codex thread</b>\n${code(message)}`);
  } finally {
    await reactQuietly(ctx, finalReaction, finalReaction === config.telegramCompleteReaction);
    activeTurns.delete(chatKey);
  }
}

bot.command("resume", async (ctx) => {
  await handleResumeCommand(ctx);
});

bot.command("resume_last", async (ctx) => {
  await handleResumeCommand(ctx, "last");
});

async function handleResumeCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const arg = overrideArg ?? getCommandArgs(ctx).trim();
  let threadId = arg;
  let session = null;
  if (!threadId || threadId.toLowerCase() === "last") {
    session = (await listRecentCodexSessions(1))[0] ?? null;
    threadId = session?.id ?? "";
  }

  if (!threadId) {
    await replyHtml(ctx, `No Codex session found. Use ${code("/new")} to start one.`);
    return;
  }

  const thread = getCodexClient(chatKey).resumeThread(threadId, buildThreadOptions(chatKey));
  threadCache.set(chatKey, thread);
  const chat = getChatState(chatKey);
  chat.threadId = threadId;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);

  await replyHtml(ctx, formatKeyValueHtml("Resumed Codex thread.", [
    ["Thread", threadId],
    ...(session ? [["Source", session.cwd], ["Time", session.timestamp]] : [])
  ]));
}

bot.command("threads", async (ctx) => {
  const sessions = await listRecentCodexSessions(8);
  if (sessions.length === 0) {
    await replyHtml(ctx, "No Codex sessions found.");
    return;
  }

  const lines = [b("Recent Codex sessions:")];
  for (const session of sessions) {
    lines.push(
      "",
      code(session.id),
      `- time: ${code(session.timestamp)}`,
      `- cwd: ${code(session.cwd)}`,
      `- source: ${code(`${session.source}/${session.originator}`)}`,
      `- resume: ${code(`/resume ${session.id}`)}`
    );
  }
  await replyHtml(ctx, lines.join("\n"));
});

bot.command("status", async (ctx) => {
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  await replyHtml(ctx, formatStatusHtml(chatKey, await buildStatusDetails(chatKey)), statusKeyboard(chatKey));
});

bot.command("options", async (ctx) => {
  await replyHtml(ctx, formatOptionsHtml(getChatKey(ctx)));
});

bot.command("settings", async (ctx) => {
  await sendPanel(ctx, "settings");
});

bot.command("model", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const value = getCommandArgs(ctx).trim();
  if (value) {
    await updateOptionCommand(ctx, "model", "model name or off");
    return;
  }
  if (await rejectIfActive(ctx, chatKey)) return;
  await sendModelSelection(ctx, chatKey);
});

bot.command("model_off", async (ctx) => {
  await updateOptionValue(ctx, "model", "off");
});

bot.command("workdir", async (ctx) => {
  await updateOptionCommand(ctx, "workingDirectory", "absolute directory");
});

bot.command("workdir_default", async (ctx) => {
  await updateOptionValue(ctx, "workingDirectory", "default");
});

bot.command("sandbox", async (ctx) => {
  await updateOptionCommand(ctx, "sandboxMode", [...VALID.sandbox].join("|"));
});

bot.command("sandbox_read_only", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "read-only");
});

bot.command("sandbox_workspace_write", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "workspace-write");
});

bot.command("sandbox_danger_full_access", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "danger-full-access");
});

bot.command("sandbox_default", async (ctx) => {
  await updateOptionValue(ctx, "sandboxMode", "default");
});

bot.command("approval", async (ctx) => {
  await updateOptionCommand(ctx, "approvalPolicy", [...VALID.approval].join("|"));
});

bot.command("approval_never", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "never");
});

bot.command("approval_on_request", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "on-request");
});

bot.command("approval_on_failure", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "on-failure");
});

bot.command("approval_untrusted", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "untrusted");
});

bot.command("approval_default", async (ctx) => {
  await updateOptionValue(ctx, "approvalPolicy", "default");
});

bot.command("reasoning", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const value = getCommandArgs(ctx).trim();
  if (value) {
    await updateOptionCommand(ctx, "modelReasoningEffort", [...VALID.reasoning].join("|"));
    return;
  }
  if (await rejectIfActive(ctx, chatKey)) return;
  await sendReasoningSelection(ctx, chatKey);
});

for (const reasoning of ["minimal", "low", "medium", "high", "xhigh", "default"]) {
  bot.command(`reasoning_${reasoning}`, async (ctx) => {
    await updateOptionValue(ctx, "modelReasoningEffort", reasoning);
  });
}

bot.command("fast", async (ctx) => {
  await handleFastCommand(ctx);
});

bot.command("fast_on", async (ctx) => {
  await handleFastCommand(ctx, "on");
});

bot.command("fast_off", async (ctx) => {
  await handleFastCommand(ctx, "off");
});

bot.command("fast_status", async (ctx) => {
  await handleFastCommand(ctx, "status");
});

async function handleFastCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  const chat = getChatState(chatKey);
  const fastEnabled = getEffectiveOptions(chatKey).serviceTier === "fast";
  const models = await listCodexModels();

  if (arg === "status") {
    await replyHtml(ctx, formatFastStatusHtml(chatKey, models));
    return;
  }

  if (!arg || arg === "toggle") {
    if (fastEnabled) delete chat.options.serviceTier;
    else chat.options.serviceTier = "fast";
  } else if (["on", "true", "yes", "1"].includes(arg)) {
    chat.options.serviceTier = "fast";
  } else if (["off", "false", "no", "0", "default"].includes(arg)) {
    delete chat.options.serviceTier;
  } else {
    await replyHtml(ctx, `Usage: ${code("/fast")}, ${code("/fast_on")}, ${code("/fast_off")}, or ${code("/fast_status")}`);
    return;
  }

  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b("Fast service tier updated.")}\n\n${formatFastStatusHtml(chatKey, models)}`);
}

bot.command("websearch", async (ctx) => {
  await updateOptionCommand(ctx, "webSearchMode", [...VALID.webSearch].join("|"));
});

for (const mode of ["disabled", "cached", "live", "default"]) {
  bot.command(`websearch_${mode}`, async (ctx) => {
    await updateOptionValue(ctx, "webSearchMode", mode);
  });
}

bot.command("network", async (ctx) => {
  await updateOptionCommand(ctx, "networkAccessEnabled", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`network_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "networkAccessEnabled", value);
  });
}

bot.command("skipgit", async (ctx) => {
  await updateOptionCommand(ctx, "skipGitRepoCheck", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`skipgit_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "skipGitRepoCheck", value);
  });
}

bot.command("adddir", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const dir = getCommandArgs(ctx).trim();
  if (!dir) {
    await replyHtml(ctx, `Usage: ${code("/adddir <absolute-directory>")}`);
    return;
  }
  await ensureDirectory(dir, "additional directory");
  const chat = getChatState(chatKey);
  chat.options.additionalDirectories = unique([...(chat.options.additionalDirectories ?? []), dir]);
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `Added directory: ${code(dir)}`);
});

bot.command("cleardirs", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const chat = getChatState(chatKey);
  delete chat.options.additionalDirectories;
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Cleared additional directories.");
});

bot.command("stream", async (ctx) => {
  await updateOptionCommand(ctx, "streamEvents", "on|off");
});

for (const value of ["on", "off", "default"]) {
  bot.command(`stream_${value}`, async (ctx) => {
    await updateOptionValue(ctx, "streamEvents", value);
  });
}

bot.command("schema", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const value = getCommandArgs(ctx).trim();
  if (!value) {
    await replyHtml(ctx, `Usage: ${code("/schema <json-schema>")} or ${code("/schema off")}`);
    return;
  }
  const chat = getChatState(chatKey);
  if (value.toLowerCase() === "off") {
    delete chat.outputSchema;
    await saveState(config.stateFile, state);
    await replyHtml(ctx, "Structured output schema disabled.");
    return;
  }
  try {
    chat.outputSchema = JSON.parse(value);
  } catch (error) {
    await replyHtml(ctx, `<b>Invalid JSON schema</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Structured output schema enabled for this chat.");
});

bot.command("schema_off", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const chat = getChatState(chatKey);
  delete chat.outputSchema;
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Structured output schema disabled.");
});

bot.command("config", async (ctx) => {
  await replyHtml(ctx, formatConfigHtml());
});

bot.command("doctor", async (ctx) => {
  await replyHtml(ctx, await formatDoctorHtml(getChatKey(ctx)));
});

bot.command("health", async (ctx) => {
  await replyHtml(ctx, await formatHealthHtml());
});

bot.command("tools", async (ctx) => {
  await sendPanel(ctx, "tools");
});

bot.command("backup", async (ctx) => {
  const backup = await createStateBackup("manual");
  await replyHtml(ctx, formatKeyValueHtml("Backup created:", [
    ["file", backup.path],
    ["size", formatBytes(backup.bytes)],
    ["chats", backup.chatCount]
  ]));
  await replyDocumentQuietly(ctx, backup.path, "Codex Telegram Bot backup");
});

bot.command("export", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const file = await createChatExport(chatKey);
  await replyHtml(ctx, formatKeyValueHtml("Chat export created:", [
    ["file", file.path],
    ["size", formatBytes(file.bytes)]
  ]));
  await replyDocumentQuietly(ctx, file.path, "Current chat export");
});

bot.command("prefs", async (ctx) => {
  await handlePrefsCommand(ctx);
});

bot.command("prefs_reset", async (ctx) => {
  await handlePrefsCommand(ctx, "reset");
});

async function handlePrefsCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  if (arg === "reset") {
    if (await rejectIfActive(ctx, chatKey)) return;
    const chat = getChatState(chatKey);
    chat.options = {};
    delete chat.outputSchema;
    invalidateThreadCache(chatKey);
    await saveState(config.stateFile, state);
    await replyHtml(ctx, `${b("Preferences reset.")}\n\n${formatPrefsHtml(chatKey)}`);
    return;
  }
  if (arg) {
    await replyHtml(ctx, `Usage: ${code("/prefs")} or ${code("/prefs_reset")}`);
    return;
  }
  await replyHtml(ctx, formatPrefsHtml(chatKey));
}

bot.command("whoami", async (ctx) => {
  await replyHtml(ctx, formatWhoamiHtml(ctx));
});

bot.command("logs", async (ctx) => {
  await replyHtml(ctx, await formatLogsHtml(ctx));
});

bot.command("logs_error", async (ctx) => {
  await replyHtml(ctx, await formatLogsHtml(ctx, "error"));
});

bot.command("stop", async (ctx) => {
  await handleStopCommand(ctx);
});

async function handleStopCommand(ctx) {
  const chatKey = getChatKey(ctx);
  const active = activeTurns.get(chatKey);
  const stoppedSideTurns = stopSideTurns(chatKey);
  if (!active && stoppedSideTurns === 0) {
    await replyHtml(ctx, "No active Codex turn.");
    return;
  }
  if (active) {
    active.stopRequested = true;
    active.abortController?.abort();
  }
  const cleared = await clearPendingTurns(chatKey);
  await replyHtml(ctx, `Stop requested.${cleared > 0 ? ` Cleared queued turns: ${code(cleared)}` : ""}${stoppedSideTurns > 0 ? ` Stopped side turns: ${code(stoppedSideTurns)}` : ""}`);
}

bot.command("queue", async (ctx) => {
  await handleQueueCommand(ctx);
});

bot.command("queue_pause", async (ctx) => {
  await handleQueueCommand(ctx, "pause");
});

bot.command("queue_resume", async (ctx) => {
  await handleQueueCommand(ctx, "resume");
});

bot.command("queue_mode", async (ctx) => {
  await handleQueueCommand(ctx, "mode");
});

for (const mode of ["safe", "interrupt", "side"]) {
  bot.command(`queue_mode_${mode}`, async (ctx) => {
    await handleQueueCommand(ctx, `mode ${mode}`);
  });
}

async function handleQueueCommand(ctx, overrideArg = null) {
  const chatKey = getChatKey(ctx);
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  const [subcommand, value] = arg.split(/\s+/, 2);
  if (subcommand === "mode") {
    if (!value) {
      await replyHtml(ctx, formatQueueModeHtml(chatKey));
      return;
    }
    if (!VALID.queueMode.has(value)) {
      await replyHtml(ctx, `Usage: ${code("/queue_mode")} or ${code("/queue_mode_safe|interrupt|side")}`);
      return;
    }
    await setQueueMode(chatKey, value);
    await replyHtml(ctx, `${b(t("queueUpdatedTitle"))}\n\n${formatQueueModeHtml(chatKey)}`);
    return;
  }
  if (arg === "pause") {
    await setQueuePaused(chatKey, true);
    await replyHtml(ctx, `${b(t("queuePausedTitle"))}\n${t("queuePausedDetail")}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (arg === "resume") {
    await setQueuePaused(chatKey, false);
    const started = await startQueueDrainIfIdle(chatKey, ctx);
    await replyHtml(ctx, `${b(t("queueResumedTitle"))}${started ? `\n${uiLanguage() === "ko" ? "대기열 실행을 다시 시작했습니다." : "Queue processing restarted."}` : ""}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (arg && arg !== "status") {
    await replyHtml(ctx, `Usage: ${code("/queue")}, ${code("/queue_pause")}, ${code("/queue_resume")}, or ${code("/queue_mode")}`);
    return;
  }
  await pruneExpiredPendingTurns(chatKey, ctx);
  await replyHtml(ctx, formatQueueHtml(chatKey), queueKeyboard(chatKey));
}

bot.command("cancelqueue", async (ctx) => {
  const chatKey = getChatKey(ctx);
  const arg = getCommandArgs(ctx).trim();
  const cleared = arg ? await removePendingTurn(chatKey, arg) : await clearPendingTurns(chatKey);
  await replyHtml(ctx, cleared > 0 ? `Cleared queued turns: ${code(cleared)}` : "No queued Codex turns.");
});

bot.command("forget", async (ctx) => {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  threadCache.delete(chatKey);
  delete state.chats[chatKey];
  delete state.queues[chatKey];
  pendingTurns.delete(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, "Forgot the Codex thread and chat-specific options.");
});

bot.command("cleanup", async (ctx) => {
  await handleCleanupCommand(ctx);
});

bot.command("cleanup_status", async (ctx) => {
  await handleCleanupCommand(ctx, "status");
});

async function handleCleanupCommand(ctx, overrideArg = null) {
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  if (!arg || arg === "status" || arg === "dry-run") {
    const plan = await createCleanupPlan("manual");
    await saveState(config.stateFile, state);
    await sendCleanupPlan(ctx, plan);
    return;
  }
  await replyHtml(ctx, `Usage: ${code("/cleanup")} or ${code("/cleanup_status")}`);
}

bot.action(/^cleanup:(quarantine|delete|both|ignore):([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const [, action, planId] = ctx.match;
  await ctx.answerCbQuery();
  const plan = state.cleanup?.plans?.[planId];
  if (!plan) {
    await editCleanupMessage(ctx, `${b(uiLanguage() === "ko" ? "🧹 Cleanup plan을 찾을 수 없습니다." : "🧹 Cleanup plan not found")}\n${uiLanguage() === "ko" ? "이미 처리되었거나 만료되었습니다." : "It was already handled or expired."}\n\n${uiLanguage() === "ko" ? "새 후보가 필요하면" : "To get fresh candidates, run"} ${code("/cleanup")}.`);
    return;
  }
  if (Date.now() > Date.parse(plan.expiresAt)) {
    delete state.cleanup.plans[planId];
    await saveState(config.stateFile, state);
    await editCleanupMessage(ctx, `${b(uiLanguage() === "ko" ? "⌛ Cleanup plan이 만료되었습니다." : "⌛ Cleanup plan expired")}\n${uiLanguage() === "ko" ? "승인 유효시간" : "Approval expired"}: ${code(formatDateTime(plan.expiresAt))}\n\n${uiLanguage() === "ko" ? "새 후보가 필요하면" : "To get fresh candidates, run"} ${code("/cleanup")}.`);
    return;
  }
  if (action === "ignore") {
    delete state.cleanup.plans[planId];
    await saveState(config.stateFile, state);
    await editCleanupMessage(ctx, formatCleanupIgnoredHtml(plan));
    return;
  }

  const result = await applyCleanupPlan(plan, action);
  delete state.cleanup.plans[planId];
  await appendCleanupLog({ type: "apply", action, planId, result, at: new Date().toISOString() });
  await saveState(config.stateFile, state);
  await editCleanupMessage(ctx, formatCleanupResultHtml(action, result, plan));
});

bot.action(/^queue:(cancel|up|next):([a-zA-Z0-9_-]+)$/, async (ctx) => {
  const [, action, turnId] = ctx.match;
  await ctx.answerCbQuery();
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  let changed = 0;
  if (action === "cancel") changed = await removePendingTurn(chatKey, turnId);
  else if (action === "up") changed = await movePendingTurn(chatKey, turnId, "up");
  else if (action === "next") changed = await movePendingTurn(chatKey, turnId, "next");

  if (changed === 0) {
    await replyHtml(ctx, "Queue item not found. Run /queue to refresh.");
    return;
  }
  await replyHtml(ctx, formatQueueHtml(chatKey), queueKeyboard(chatKey));
});

bot.action(/^model:set:([a-zA-Z0-9._-]+|default)$/, async (ctx) => {
  const [, model] = ctx.match;
  await ctx.answerCbQuery();
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const chat = getChatState(chatKey);
  if (model === "default") delete chat.options.model;
  else chat.options.model = model;
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b("Model updated.")}\n\n${formatReasoningPromptHtml(chatKey)}`, reasoningSelectionKeyboard());
});

bot.action(/^reasoning:set:(minimal|low|medium|high|xhigh|default)$/, async (ctx) => {
  const [, reasoning] = ctx.match;
  await ctx.answerCbQuery();
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;

  const chat = getChatState(chatKey);
  if (reasoning === "default") delete chat.options.modelReasoningEffort;
  else chat.options.modelReasoningEffort = reasoning;
  invalidateThreadCache(chatKey);
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b("Thinking updated.")}\n\n${formatOptionsHtml(chatKey)}`);
});

bot.action(/^p:([a-z_]+)$/, async (ctx) => {
  const [, panel] = ctx.match;
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel, { edit: true });
});

bot.action(/^q:(pause|resume|clear|mode)(?::(safe|interrupt|side))?$/, async (ctx) => {
  const [, action, value] = ctx.match;
  await ctx.answerCbQuery();
  await handleQueueButton(ctx, action, value || "");
});

bot.action(/^set:([a-z_]+):([a-z0-9_-]+)$/, async (ctx) => {
  const [, key, value] = ctx.match;
  await ctx.answerCbQuery();
  await handleSettingButton(ctx, key, value);
});

bot.action(/^tool:([a-z_]+)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  await handleToolButton(ctx, action);
});

bot.action(/^act:(new|resume_last|stop)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  if (action === "new") {
    await handleNewCommand(ctx);
  } else if (action === "resume_last") {
    await handleResumeCommand(ctx, "last");
  } else if (action === "stop") {
    await handleStopCommand(ctx);
  }
});

bot.action(/^confirm:(q_clear|forget|prefs_reset)$/, async (ctx) => {
  const [, action] = ctx.match;
  await ctx.answerCbQuery();
  await handleConfirmButton(ctx, action);
});

bot.on("photo", async (ctx) => {
  await handleCodexMessage(ctx, ctx.message.caption?.trim() || "Analyze this image.", async () => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return [];
    return [await downloadTelegramFile(ctx, photo.file_id, ".jpg")];
  });
});

bot.on("document", async (ctx) => {
  const document = ctx.message.document;
  if (!document?.mime_type?.startsWith("image/")) {
    await ctx.reply("Only image documents are supported by the Codex SDK input bridge.");
    return;
  }
  const ext = path.extname(document.file_name ?? "") || extensionFromMime(document.mime_type);
  await handleCodexMessage(ctx, ctx.message.caption?.trim() || "Analyze this image.", async () => {
    return [await downloadTelegramFile(ctx, document.file_id, ext)];
  });
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || isRegisteredTelegramCommandText(ctx.message)) return;
  await handleCodexMessage(ctx, text, async () => []);
});

bot.on("message", async (ctx) => {
  await ctx.reply("Only text messages and image attachments are supported.");
});

await ensureDirectory(config.codexWorkdir, "CODEX_WORKDIR");
await fs.mkdir(config.uploadDir, { recursive: true });
await fs.mkdir(config.cleanupQuarantineDir, { recursive: true });
await fs.mkdir(config.backupDir, { recursive: true });
startCleanupScheduler();
startStateSnapshotScheduler();
registerTelegramCommands().catch((error) => {
  console.warn("Telegram command menu registration failed:", error instanceof Error ? error.message : String(error));
});
await bot.launch();
console.log("codex-telegram-bot started");
startPersistedQueues();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

async function handleCodexMessage(ctx, text, loadImages) {
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  if (isStatusQuestion(text) && (activeTurns.has(chatKey) || getPendingTurns(chatKey).length > 0)) {
    await replyHtml(ctx, formatStatusHtml(chatKey, await buildStatusDetails(chatKey)));
    return;
  }

  if (activeTurns.has(chatKey)) {
    const mode = getQueueMode(chatKey);
    if (mode === "interrupt") {
      await handleInterruptMessage(ctx, chatKey, text, loadImages);
      return;
    }
    if (mode === "side") {
      await handleSideMessage(ctx, chatKey, text, loadImages);
      return;
    }
    await handleSafeQueuedMessage(ctx, chatKey, text, loadImages);
    return;
  }

  if (isQueuePaused(chatKey) && getPendingTurns(chatKey).length > 0) {
    await handleSafeQueuedMessage(ctx, chatKey, text, loadImages);
    return;
  }

  const active = { abortController: null, stopRequested: false };
  activeTurns.set(chatKey, active);
  try {
    const preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
    if (active.interruptBeforeStart) {
      const nextTurn = await dequeuePendingTurn(chatKey, ctx);
      if (nextTurn) startPreparedTurnQueueInBackground(chatKey, nextTurn, active);
      else activeTurns.delete(chatKey);
      return;
    }
    startPreparedTurnQueueInBackground(chatKey, preparedTurn, active);
  } catch (error) {
    await replyHtml(ctx, `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    const nextTurn = await dequeuePendingTurn(chatKey, ctx);
    if (nextTurn) startPreparedTurnQueueInBackground(chatKey, nextTurn, active);
    else activeTurns.delete(chatKey);
  }
}

async function handleSafeQueuedMessage(ctx, chatKey, text, loadImages) {
  let preparedTurn;
  try {
    preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
  } catch (error) {
    await replyHtml(ctx, `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  const queued = await enqueuePendingTurn(chatKey, preparedTurn);
  if (!queued.ok) {
    await replyHtml(ctx, `${b("Codex queue is full.")}\nMax queued turns: ${code(runtimeValue("telegramPendingTurnsMax"))}\nUse ${code("/queue")} or ${code("/cancelqueue")}.`);
    return;
  }
  const paused = isQueuePaused(chatKey) ? "\nQueue is paused. Use /queue_resume to continue." : "";
  await replyHtml(ctx, `Queued Codex turn: ${code(`#${queued.position}`)}${paused}\nUse ${code("/queue")} to inspect or ${code("/cancelqueue")} to clear.`);
}

async function handleInterruptMessage(ctx, chatKey, text, loadImages) {
  let preparedTurn;
  try {
    preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
  } catch (error) {
    await replyHtml(ctx, `<b>Failed to prepare Codex input</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    return;
  }

  const active = activeTurns.get(chatKey);
  if (!active) {
    await startPreparedTurnQueue(chatKey, preparedTurn);
    return;
  }

  const queued = await enqueuePendingTurnFront(chatKey, preparedTurn);
  if (!queued.ok) {
    await replyHtml(ctx, `${b("Codex queue is full.")}\nMax queued turns: ${code(runtimeValue("telegramPendingTurnsMax"))}\nUse ${code("/queue")} or ${code("/cancelqueue")}.`);
    return;
  }

  active.interruptRequested = true;
  if (active.abortController) active.abortController.abort();
  else active.interruptBeforeStart = true;
  await replyHtml(ctx, `${b("Interrupt requested.")}\n현재 turn을 중단하고 새 메시지를 다음 turn으로 바로 실행합니다.`);
}

async function handleSideMessage(ctx, chatKey, text, loadImages) {
  let preparedTurn;
  try {
    preparedTurn = await prepareCodexTurn(ctx, text, loadImages);
  } catch (error) {
    await replyHtml(ctx, `<b>Failed to prepare side input</b>\n${code(error instanceof Error ? error.message : String(error))}`);
    return;
  }

  processSideTurn(chatKey, preparedTurn).catch(async (error) => {
    await replyHtml(ctx, `<b>Side turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`).catch(() => {});
  });
  await replyHtml(ctx, `${b("Side turn started.")}\n현재 작업은 유지하고, 별도 thread에서 답변합니다.`);
}

async function startPreparedTurnQueue(chatKey, preparedTurn) {
  const active = { abortController: null, stopRequested: false };
  activeTurns.set(chatKey, active);
  startPreparedTurnQueueInBackground(chatKey, preparedTurn, active);
}

function startPreparedTurnQueueInBackground(chatKey, preparedTurn, active) {
  runPreparedTurnQueue(chatKey, preparedTurn, active).catch(async (error) => {
    activeTurns.delete(chatKey);
    const ctx = ensureTurnContext(preparedTurn);
    await replyHtml(ctx, `<b>Queued Codex turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`).catch(() => {});
  });
}

async function processSideTurn(chatKey, preparedTurn) {
  const ctx = ensureTurnContext(preparedTurn);
  const abortController = new AbortController();
  trackSideTurn(chatKey, abortController);
  let finalReaction = "";
  await reactQuietly(ctx, config.telegramThinkingReaction);
  const typingInterval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4500);

  try {
    const input = buildInput(applySideThreadPrompt(preparedTurn.inputText), preparedTurn.imagePaths);
    const thread = getCodexClient(chatKey).startThread(buildThreadOptions(chatKey));
    const turn = await runCodexTurn(ctx, chatKey, thread, input, abortController.signal, undefined, null, { rememberThreadId: false });
    const response = formatTurn(turn);
    await replyHtml(ctx, b("Side reply"));
    await replyCodexAnswer(ctx, response || "Side Codex turn completed without a final message.");
    finalReaction = config.telegramCompleteReaction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalReaction = abortController.signal.aborted ? config.telegramStoppedReaction : config.telegramErrorReaction;
    await replyHtml(ctx, `<b>Side Codex failed</b>\n${code(message)}`);
  } finally {
    clearInterval(typingInterval);
    untrackSideTurn(chatKey, abortController);
    await reactQuietly(ctx, finalReaction, finalReaction === config.telegramCompleteReaction);
  }
}

function applySideThreadPrompt(inputText) {
  return [
    "This is a side reply while the main Telegram Codex turn continues.",
    "Answer the user directly. Avoid file changes or write commands; if the request requires changing files, say it should be queued in safe mode instead.",
    "",
    inputText
  ].join("\n");
}

async function prepareCodexTurn(ctx, text, loadImages) {
  const replyContext = await buildReplyContext(ctx);
  const imagePaths = [...replyContext.imagePaths, ...await loadImages()];
  const inputText = applyPersonaPrompt(mergeReplyContext(text, replyContext));
  const enqueuedAt = new Date();
  return {
    id: createQueueItemId(),
    ctx,
    chatKey: getChatKey(ctx),
    chatId: ctx.chat?.id ?? ctx.from?.id,
    text,
    inputText,
    imagePaths,
    enqueuedAt: enqueuedAt.toISOString(),
    expiresAt: new Date(enqueuedAt.getTime() + runtimeValue("telegramPendingTurnMaxAgeSeconds") * 1000).toISOString()
  };
}

async function runPreparedTurnQueue(chatKey, firstTurn, active) {
  let nextTurn = firstTurn;
  while (nextTurn) {
    active.interruptBeforeStart = false;
    active.abortController = new AbortController();
    await processPreparedTurn(chatKey, nextTurn, active);
    if (active.stopRequested) break;
    if (isQueuePaused(chatKey)) break;
    nextTurn = await dequeuePendingTurn(chatKey, nextTurn.ctx);
  }

  activeTurns.delete(chatKey);
}

async function processPreparedTurn(chatKey, preparedTurn, active) {
  const startedAt = Date.now();
  let finalReaction = "";
  const ctx = ensureTurnContext(preparedTurn);
  active.currentTurnStartedAt = new Date(startedAt).toISOString();
  active.currentText = preparedTurn.text;
  active.currentQueueItemId = preparedTurn.id || "";
  active.lastProgress = "";
  active.lastProgressAt = "";
  const liveProgress = createLiveProgressState(active);
  liveProgress.chatKey = chatKey;
  let turnSucceeded = false;
  await reactQuietly(ctx, config.telegramThinkingReaction);
  const typingInterval = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4500);

  try {
    const input = buildInput(preparedTurn.inputText, preparedTurn.imagePaths);
    const thread = getOrCreateThread(chatKey);
    const turn = await runCodexTurn(ctx, chatKey, thread, input, active.abortController.signal, undefined, liveProgress);
    await rememberThread(chatKey, thread);
    const response = formatTurn(turn);
    await replyCodexAnswer(ctx, response || "Codex completed without a final message.");
    turnSucceeded = true;
    finalReaction = config.telegramCompleteReaction;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalReaction = active.abortController.signal.aborted ? config.telegramStoppedReaction : config.telegramErrorReaction;
    if (active.interruptRequested && active.abortController.signal.aborted) {
      await replyHtml(ctx, `${b("Codex turn interrupted.")}\n새 메시지를 다음 turn으로 실행합니다.`);
      active.interruptRequested = false;
    } else {
      await replyHtml(ctx, `<b>Codex failed</b>\n${code(message)}`);
    }
  } finally {
    if (shouldDeleteLiveProgress(liveProgress, turnSucceeded)) await deleteTrackedProgressMessages(ctx, liveProgress);
    clearInterval(typingInterval);
    await reactQuietly(ctx, finalReaction, finalReaction === config.telegramCompleteReaction);
  }
}

async function runCodexTurn(ctx, chatKey, thread, input, signal, workingMessageId, liveProgress = null, options = {}) {
  const turnOptions = buildTurnOptions(chatKey, signal);
  if (!getEffectiveOptions(chatKey).streamEvents) {
    return thread.run(input, turnOptions);
  }

  const { events } = await thread.runStreamed(input, turnOptions);
  const items = new Map();
  let finalResponse = "";
  let usage = null;
  let lastProgressAt = 0;
  const progressState = liveProgress;

  for await (const event of events) {
    if (event.type === "thread.started") {
      if (options.rememberThreadId !== false) {
        const chat = getChatState(chatKey);
        chat.threadId = event.thread_id;
        await saveState(config.stateFile, state);
      }
    } else if (event.type === "turn.started") {
      // Handled by live progress below.
    } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      items.set(event.item.id, event.item);
      if (event.item.type === "agent_message") finalResponse = event.item.text;
      const now = Date.now();
      if (workingMessageId && now - lastProgressAt > runtimeValue("progressEditIntervalMs")) {
        lastProgressAt = now;
        await editMessageQuietly(ctx, workingMessageId, summarizeProgress([...items.values()]));
      }
    } else if (event.type === "turn.completed") {
      usage = event.usage;
    } else if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
    await maybeSendLiveProgress(ctx, progressState, event, [...items.values()]);
  }

  return { items: [...items.values()], finalResponse, usage };
}

function readConfig() {
  const homeDir = process.env.HOME || process.cwd();
  const defaultCodexHome = path.join(homeDir, ".codex");
  const defaultCodexSessionsDir = path.join(defaultCodexHome, "sessions");
  const codexHome = process.env.CODEX_HOME?.trim()
    || path.dirname(process.env.CODEX_SESSIONS_DIR?.trim() || defaultCodexSessionsDir);
  const codexSessionsDir = process.env.CODEX_SESSIONS_DIR?.trim() || path.join(codexHome, "sessions");
  const stateRoot = path.join(appRoot, "state");

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken || telegramBotToken.includes("replace_me")) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and set it.");
  }

  const allowedUserIds = new Set(
    (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (allowedUserIds.size === 0) throw new Error("ALLOWED_USER_IDS is required.");

  return {
    telegramBotToken,
    allowedUserIds,
    codexWorkdir: process.env.CODEX_WORKDIR?.trim() || homeDir,
    codexPath: process.env.CODEX_PATH?.trim() || "codex",
    codexModel: process.env.CODEX_MODEL?.trim() || "",
    codexApprovalPolicy: process.env.CODEX_APPROVAL_POLICY?.trim() || "never",
    codexSandboxMode: process.env.CODEX_SANDBOX_MODE?.trim() || "workspace-write",
    codexReasoningEffort: process.env.CODEX_REASONING_EFFORT?.trim() || "medium",
    codexWebSearch: process.env.CODEX_WEB_SEARCH?.trim() || "disabled",
    codexPersonaPrompt: normalizeMultilineEnv(process.env.CODEX_PERSONA_PROMPT),
    codexNetworkAccess: parseOptionalBoolean(process.env.CODEX_NETWORK_ACCESS),
    codexWebSearchEnabled: parseOptionalBoolean(process.env.CODEX_WEB_SEARCH_ENABLED),
    codexSkipGitRepoCheck: parseOptionalBoolean(process.env.CODEX_SKIP_GIT_REPO_CHECK) ?? true,
    codexAdditionalDirectories: parseCsv(process.env.CODEX_ADDITIONAL_DIRECTORIES),
    codexBaseUrl: process.env.CODEX_BASE_URL?.trim() || "",
    codexApiKey: process.env.CODEX_API_KEY?.trim() || "",
    codexConfig: parseOptionalJson("CODEX_CONFIG_JSON"),
    codexEnv: parseOptionalJson("CODEX_ENV_JSON"),
    codexModelsCacheFile: process.env.CODEX_MODELS_CACHE_FILE?.trim() || path.join(codexHome, "models_cache.json"),
    telegramLanguage: parseLanguage(process.env.TELEGRAM_LANGUAGE),
    telegramTimeZone: parseTimeZone(process.env.TELEGRAM_TIME_ZONE),
    telegramLocale: parseLocale(process.env.TELEGRAM_LOCALE),
    stateFile: process.env.STATE_FILE?.trim() || path.join(stateRoot, "threads.json"),
    codexHome,
    codexSessionsDir,
    codexMaintenanceScript: process.env.CODEX_MAINTENANCE_SCRIPT?.trim() || path.join(appRoot, "scripts", "codex_maintenance.py"),
    codexMaintenanceBackupDir: process.env.CODEX_MAINTENANCE_BACKUP_DIR?.trim() || path.join(stateRoot, "codex-maintenance"),
    codexMaintenanceWorktreeDays: Number(process.env.CODEX_MAINTENANCE_WORKTREE_DAYS || 7),
    codexMaintenanceLogRotateMb: Number(process.env.CODEX_MAINTENANCE_LOG_ROTATE_MB || 64),
    codexMaintenanceThreadTitleLimit: Number(process.env.CODEX_MAINTENANCE_THREAD_TITLE_LIMIT || 120),
    codexMaintenanceThreadPreviewLimit: Number(process.env.CODEX_MAINTENANCE_THREAD_PREVIEW_LIMIT || 240),
    codexMaintenanceAutoSqliteRepairEnabled: parseOptionalBoolean(process.env.CODEX_MAINTENANCE_AUTO_SQLITE_REPAIR_ENABLED) ?? false,
    codexMaintenanceAutoHandoffEnabled: parseOptionalBoolean(process.env.CODEX_MAINTENANCE_AUTO_HANDOFF_ENABLED) ?? false,
    codexHandoffDir: process.env.CODEX_HANDOFF_DIR?.trim() || path.join(codexHome, "handoffs"),
    codexHandoffRecentEvents: parseNonnegativeInteger(process.env.CODEX_HANDOFF_RECENT_EVENTS, 40),
    uploadDir: process.env.UPLOAD_DIR?.trim() || path.join(stateRoot, "uploads"),
    maxTelegramChars: Number(process.env.MAX_TELEGRAM_CHARS || 3500),
    progressEditIntervalMs: Number(process.env.PROGRESS_EDIT_INTERVAL_MS || 8000),
    telegramReactionsEnabled: parseOptionalBoolean(process.env.TELEGRAM_REACTIONS_ENABLED) ?? true,
    telegramThinkingReaction: process.env.TELEGRAM_THINKING_REACTION?.trim() || "🤔",
    telegramCompleteReaction: process.env.TELEGRAM_COMPLETE_REACTION?.trim() || "👌",
    telegramErrorReaction: process.env.TELEGRAM_ERROR_REACTION?.trim() || "😢",
    telegramStoppedReaction: process.env.TELEGRAM_STOPPED_REACTION?.trim() || "😴",
    telegramFormatCodexAnswers: parseCodexAnswerFormat(process.env.TELEGRAM_FORMAT_CODEX_ANSWERS),
    telegramCompletionNoticeSeconds: Number(process.env.TELEGRAM_COMPLETION_NOTICE_SECONDS || 90),
    telegramPendingTurnsMax: parseNonnegativeInteger(process.env.TELEGRAM_PENDING_TURNS_MAX, 10),
    telegramPendingTurnMaxAgeSeconds: parseNonnegativeInteger(process.env.TELEGRAM_PENDING_TURN_MAX_AGE_SECONDS, 7200),
    telegramLiveProgressEnabled: parseOptionalBoolean(process.env.TELEGRAM_LIVE_PROGRESS_ENABLED) ?? true,
    telegramLiveProgressIntervalMs: parseNonnegativeInteger(process.env.TELEGRAM_LIVE_PROGRESS_INTERVAL_SECONDS, 30) * 1000,
    telegramLiveProgressMode: process.env.TELEGRAM_LIVE_PROGRESS_MODE?.trim() || "brief",
    telegramLiveProgressSource: parseLiveProgressSource(process.env.TELEGRAM_LIVE_PROGRESS_SOURCE),
    telegramLiveProgressDeletePolicy: parseLiveProgressDeletePolicy(process.env.TELEGRAM_LIVE_PROGRESS_DELETE_POLICY),
    cleanupEnabled: parseOptionalBoolean(process.env.CLEANUP_ENABLED) ?? true,
    cleanupNotifyTime: process.env.CLEANUP_NOTIFY_TIME?.trim() || "09:00",
    cleanupNotifyChatIds: parseCsv(process.env.CLEANUP_NOTIFY_CHAT_IDS).length > 0 ? parseCsv(process.env.CLEANUP_NOTIFY_CHAT_IDS) : [...allowedUserIds],
    cleanupRetentionDays: Number(process.env.CLEANUP_RETENTION_DAYS || 14),
    cleanupQuarantineDays: Number(process.env.CLEANUP_QUARANTINE_DAYS || 7),
    cleanupQuarantineDir: process.env.CLEANUP_QUARANTINE_DIR?.trim() || path.join(codexHome, "session-quarantine"),
    cleanupLogFile: process.env.CLEANUP_LOG_FILE?.trim() || path.join(stateRoot, "cleanup-log.jsonl"),
    cleanupArtifactDir: process.env.CLEANUP_ARTIFACT_DIR?.trim() || path.join(stateRoot, "cleanup-artifacts"),
    cleanupPlanTtlHours: Number(process.env.CLEANUP_PLAN_TTL_HOURS || 24),
    backupDir: process.env.BACKUP_DIR?.trim() || path.join(stateRoot, "backups"),
    snapshotEnabled: parseOptionalBoolean(process.env.SNAPSHOT_ENABLED) ?? true,
    snapshotNotifyTime: process.env.SNAPSHOT_NOTIFY_TIME?.trim() || "03:30",
    snapshotRetentionDays: Number(process.env.SNAPSHOT_RETENTION_DAYS || 14),
    logsMaxLines: Number(process.env.LOGS_MAX_LINES || 80)
  };
}

function buildCodexOptions(serviceTier = "") {
  const options = { codexPathOverride: config.codexPath };
  if (config.codexBaseUrl) options.baseUrl = config.codexBaseUrl;
  if (config.codexApiKey) options.apiKey = config.codexApiKey;
  const codexConfig = { ...(config.codexConfig ?? {}) };
  if (serviceTier) codexConfig.service_tier = serviceTier;
  if (Object.keys(codexConfig).length > 0) options.config = codexConfig;
  if (config.codexEnv) options.env = config.codexEnv;
  return options;
}

function getCodexClient(chatKey) {
  const serviceTier = getEffectiveOptions(chatKey).serviceTier || "";
  const cacheKey = serviceTier || "default";
  if (!codexClients.has(cacheKey)) {
    codexClients.set(cacheKey, new Codex(buildCodexOptions(serviceTier)));
  }
  return codexClients.get(cacheKey);
}

function defaultChatOptions() {
  const options = {
    workingDirectory: config.codexWorkdir,
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
    approvalPolicy: config.codexApprovalPolicy,
    sandboxMode: config.codexSandboxMode,
    modelReasoningEffort: config.codexReasoningEffort,
    webSearchMode: config.codexWebSearch,
    streamEvents: true,
    liveProgressEnabled: runtimeValue("telegramLiveProgressEnabled"),
    liveProgressSource: config.telegramLiveProgressSource,
    liveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy
  };
  if (config.codexModel) options.model = config.codexModel;
  if (typeof config.codexNetworkAccess === "boolean") options.networkAccessEnabled = config.codexNetworkAccess;
  if (typeof config.codexWebSearchEnabled === "boolean") options.webSearchEnabled = config.codexWebSearchEnabled;
  if (config.codexAdditionalDirectories.length > 0) options.additionalDirectories = config.codexAdditionalDirectories;
  return options;
}

function buildThreadOptions(chatKey) {
  const { streamEvents, serviceTier, liveProgressEnabled, liveProgressSource, liveProgressDeletePolicy, ...threadOptions } = getEffectiveOptions(chatKey);
  return threadOptions;
}

function buildTurnOptions(chatKey, signal) {
  const chat = getChatState(chatKey);
  const options = { signal };
  if (chat.outputSchema) options.outputSchema = chat.outputSchema;
  return options;
}

function getEffectiveOptions(chatKey) {
  return { ...defaultChatOptions(), ...getChatState(chatKey).options };
}

function getChatState(chatKey) {
  if (!state.chats[chatKey]) {
    state.chats[chatKey] = { options: {}, updatedAt: new Date().toISOString() };
  }
  if (!state.chats[chatKey].options) state.chats[chatKey].options = {};
  return state.chats[chatKey];
}

function getOrCreateThread(chatKey) {
  const cached = threadCache.get(chatKey);
  if (cached) return cached;

  const savedThreadId = getChatState(chatKey).threadId;
  const thread = savedThreadId
    ? getCodexClient(chatKey).resumeThread(savedThreadId, buildThreadOptions(chatKey))
    : getCodexClient(chatKey).startThread(buildThreadOptions(chatKey));
  threadCache.set(chatKey, thread);
  return thread;
}

async function rememberThread(chatKey, thread) {
  if (!thread.id) return;
  const chat = getChatState(chatKey);
  chat.threadId = thread.id;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

async function updateOptionCommand(ctx, key, usage) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  const value = getCommandArgs(ctx).trim();
  if (!value) {
    await replyHtml(ctx, `Usage: ${code(`/${commandName(ctx)} <${usage}>`)}`);
    return;
  }
  await updateOptionValue(ctx, key, value);
}

async function updateOptionValue(ctx, key, value) {
  const chatKey = getChatKey(ctx);
  if (await rejectIfActive(ctx, chatKey)) return;
  try {
    await setOption(chatKey, key, value);
  } catch (error) {
    await replyHtml(ctx, code(error instanceof Error ? error.message : String(error)));
    return;
  }
  await saveState(config.stateFile, state);
  await replyHtml(ctx, `${b(`Updated ${key}.`)}\n\n${formatOptionsHtml(chatKey)}`);
}

async function setOption(chatKey, key, rawValue) {
  const chat = getChatState(chatKey);
  const value = rawValue.trim();
  const lower = value.toLowerCase();
  if (lower === "off" || lower === "default" || lower === "clear") {
    delete chat.options[key];
    invalidateThreadCache(chatKey);
    return;
  }

  if (key === "model") chat.options.model = value;
  else if (key === "workingDirectory") {
    await ensureDirectory(value, "working directory");
    chat.options.workingDirectory = value;
  } else if (key === "sandboxMode") {
    assertEnum(value, VALID.sandbox, "sandbox");
    chat.options.sandboxMode = value;
  } else if (key === "approvalPolicy") {
    assertEnum(value, VALID.approval, "approval");
    chat.options.approvalPolicy = value;
  } else if (key === "modelReasoningEffort") {
    assertEnum(value, VALID.reasoning, "reasoning");
    chat.options.modelReasoningEffort = value;
  } else if (key === "webSearchMode") {
    assertEnum(value, VALID.webSearch, "websearch");
    chat.options.webSearchMode = value;
  } else if (key === "serviceTier") {
    assertEnum(value, VALID.serviceTier, "service tier");
    chat.options.serviceTier = value;
  } else if (key === "liveProgressSource") {
    assertEnum(value, VALID.liveProgressSource, "live progress source");
    chat.options.liveProgressSource = value;
  } else if (key === "liveProgressDeletePolicy") {
    assertEnum(value, VALID.liveProgressDeletePolicy, "live progress delete policy");
    chat.options.liveProgressDeletePolicy = value;
  } else if (key === "networkAccessEnabled" || key === "skipGitRepoCheck" || key === "streamEvents" || key === "liveProgressEnabled") {
    chat.options[key] = parseRequiredBoolean(value, key);
  } else {
    throw new Error(`Unknown option: ${key}`);
  }
  invalidateThreadCache(chatKey);
}

function invalidateThreadCache(chatKey) {
  threadCache.delete(chatKey);
  getChatState(chatKey).updatedAt = new Date().toISOString();
}

async function rejectIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await replyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`);
  return true;
}

function getPendingTurns(chatKey) {
  return pendingTurns.get(chatKey) ?? [];
}

async function enqueuePendingTurn(chatKey, preparedTurn) {
  const queue = getPendingTurns(chatKey);
  const max = Math.max(0, runtimeValue("telegramPendingTurnsMax"));
  if (queue.length >= max) return { ok: false, position: queue.length };
  queue.push(preparedTurn);
  pendingTurns.set(chatKey, queue);
  await persistPendingTurns(chatKey);
  return { ok: true, position: queue.length };
}

async function enqueuePendingTurnFront(chatKey, preparedTurn) {
  const queue = getPendingTurns(chatKey);
  const max = Math.max(0, runtimeValue("telegramPendingTurnsMax"));
  if (queue.length >= max) return { ok: false, position: queue.length };
  queue.unshift(preparedTurn);
  pendingTurns.set(chatKey, queue);
  await persistPendingTurns(chatKey);
  return { ok: true, position: 1 };
}

async function dequeuePendingTurn(chatKey, ctx = null) {
  const queue = getPendingTurns(chatKey);
  let next = null;
  let expired = 0;
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (isPendingTurnExpired(candidate)) {
      expired += 1;
      continue;
    }
    next = candidate;
    break;
  }
  if (queue.length > 0) pendingTurns.set(chatKey, queue);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  if (expired > 0 && ctx) await notifyExpiredPendingTurns(ctx, expired);
  return next;
}

async function clearPendingTurns(chatKey) {
  const count = getPendingTurns(chatKey).length;
  pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  return count;
}

async function removePendingTurn(chatKey, selector) {
  const queue = getPendingTurns(chatKey);
  const index = findPendingTurnIndex(queue, selector);
  if (index < 0) return 0;
  queue.splice(index, 1);
  if (queue.length > 0) pendingTurns.set(chatKey, queue);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  return 1;
}

async function movePendingTurn(chatKey, turnId, direction) {
  const queue = getPendingTurns(chatKey);
  const index = findPendingTurnIndex(queue, turnId);
  if (index < 0) return 0;
  if (direction === "next") {
    const [turn] = queue.splice(index, 1);
    queue.unshift(turn);
  } else if (direction === "up" && index > 0) {
    [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
  }
  pendingTurns.set(chatKey, queue);
  await persistPendingTurns(chatKey);
  return 1;
}

function countPendingTurns() {
  let count = 0;
  for (const queue of pendingTurns.values()) count += queue.length;
  return count;
}

function hydratePendingTurnsFromState() {
  for (const [chatKey, queue] of Object.entries(state.queues ?? {})) {
    if (!Array.isArray(queue)) continue;
    const hydrated = queue
      .map((turn) => normalizePendingTurn(turn, chatKey))
      .filter(Boolean)
      .filter((turn) => !isPendingTurnExpired(turn));
    if (hydrated.length > 0) pendingTurns.set(chatKey, hydrated);
    else delete state.queues[chatKey];
  }
}

function normalizePendingTurn(turn, chatKey) {
  if (!turn || typeof turn !== "object" || typeof turn.inputText !== "string") return null;
  const now = new Date();
  const enqueuedAt = Number.isNaN(Date.parse(turn.enqueuedAt)) ? now.toISOString() : turn.enqueuedAt;
  return {
    id: typeof turn.id === "string" && turn.id ? turn.id : createQueueItemId(),
    chatKey,
    chatId: turn.chatId ?? chatKey,
    text: typeof turn.text === "string" ? turn.text : turn.inputText,
    inputText: turn.inputText,
    imagePaths: Array.isArray(turn.imagePaths) ? turn.imagePaths.filter((entry) => typeof entry === "string") : [],
    enqueuedAt,
    expiresAt: Number.isNaN(Date.parse(turn.expiresAt))
      ? new Date(Date.parse(enqueuedAt) + runtimeValue("telegramPendingTurnMaxAgeSeconds") * 1000).toISOString()
      : turn.expiresAt
  };
}

function serializePendingTurn(turn) {
  return {
    id: turn.id,
    chatKey: turn.chatKey,
    chatId: turn.chatId,
    text: turn.text,
    inputText: turn.inputText,
    imagePaths: turn.imagePaths,
    enqueuedAt: turn.enqueuedAt,
    expiresAt: turn.expiresAt
  };
}

async function persistPendingTurns(chatKey) {
  const queue = getPendingTurns(chatKey).map(serializePendingTurn);
  if (queue.length > 0) state.queues[chatKey] = queue;
  else delete state.queues[chatKey];
  await saveState(config.stateFile, state);
}

async function pruneExpiredPendingTurns(chatKey, ctx = null) {
  const queue = getPendingTurns(chatKey);
  const fresh = queue.filter((turn) => !isPendingTurnExpired(turn));
  const expired = queue.length - fresh.length;
  if (expired === 0) return 0;
  if (fresh.length > 0) pendingTurns.set(chatKey, fresh);
  else pendingTurns.delete(chatKey);
  await persistPendingTurns(chatKey);
  if (ctx) await notifyExpiredPendingTurns(ctx, expired);
  return expired;
}

function isPendingTurnExpired(turn) {
  if (runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0) return false;
  const expiresAt = Date.parse(turn?.expiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

async function notifyExpiredPendingTurns(ctx, count) {
  await replyHtml(ctx, `만료된 queued turn을 정리했습니다: ${code(count)}개`);
}

function findPendingTurnIndex(queue, selector) {
  const value = String(selector ?? "").trim();
  if (!value) return -1;
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index >= 0 && index < queue.length) return index;
  }
  return queue.findIndex((turn) => turn.id === value);
}

function createQueueItemId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isQueuePaused(chatKey) {
  return getChatState(chatKey).queuePaused === true;
}

function getQueueMode(chatKey) {
  const mode = getChatState(chatKey).queueMode;
  return VALID.queueMode.has(mode) ? mode : "safe";
}

async function setQueuePaused(chatKey, paused) {
  const chat = getChatState(chatKey);
  chat.queuePaused = paused;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

async function setQueueMode(chatKey, mode) {
  const chat = getChatState(chatKey);
  chat.queueMode = mode;
  chat.updatedAt = new Date().toISOString();
  await saveState(config.stateFile, state);
}

function trackSideTurn(chatKey, abortController) {
  const controllers = sideTurns.get(chatKey) ?? new Set();
  controllers.add(abortController);
  sideTurns.set(chatKey, controllers);
}

function untrackSideTurn(chatKey, abortController) {
  const controllers = sideTurns.get(chatKey);
  if (!controllers) return;
  controllers.delete(abortController);
  if (controllers.size === 0) sideTurns.delete(chatKey);
}

function stopSideTurns(chatKey) {
  const controllers = sideTurns.get(chatKey);
  if (!controllers) return 0;
  const count = controllers.size;
  for (const controller of controllers) controller.abort();
  return count;
}

function getSideTurnCount(chatKey) {
  return sideTurns.get(chatKey)?.size ?? 0;
}

function countSideTurns() {
  let count = 0;
  for (const controllers of sideTurns.values()) count += controllers.size;
  return count;
}

async function startQueueDrainIfIdle(chatKey, ctx = null) {
  if (activeTurns.has(chatKey) || isQueuePaused(chatKey)) return false;
  const runCtx = ctx ?? createSyntheticCtx(chatKey);
  const firstTurn = await dequeuePendingTurn(chatKey, runCtx);
  if (!firstTurn) return false;

  const active = { abortController: null, stopRequested: false };
  activeTurns.set(chatKey, active);
  runPreparedTurnQueue(chatKey, firstTurn, active).catch(async (error) => {
    activeTurns.delete(chatKey);
    await replyHtml(runCtx, `<b>Queued Codex turn failed</b>\n${code(error instanceof Error ? error.message : String(error))}`).catch(() => {});
  });
  return true;
}

function startPersistedQueues() {
  setTimeout(() => {
    for (const chatKey of pendingTurns.keys()) {
      startQueueDrainIfIdle(chatKey).catch((error) => {
        console.warn("persisted queue start failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }, 3000);
}

function createSyntheticCtx(chatKey) {
  const chatId = Number.isNaN(Number(chatKey)) ? chatKey : Number(chatKey);
  return {
    chat: { id: chatId },
    from: { id: chatId },
    telegram: bot.telegram,
    reply: (text, extra = {}) => bot.telegram.sendMessage(chatId, text, extra),
    sendChatAction: (action) => bot.telegram.sendChatAction(chatId, action)
  };
}

function ensureTurnContext(turn) {
  if (turn.ctx) return turn.ctx;
  turn.ctx = createSyntheticCtx(String(turn.chatId ?? turn.chatKey));
  return turn.ctx;
}

function buildInput(text, imagePaths) {
  if (imagePaths.length === 0) return text;
  return [
    { type: "text", text },
    ...imagePaths.map((imagePath) => ({ type: "local_image", path: imagePath }))
  ];
}

async function buildReplyContext(ctx) {
  const message = ctx.message?.reply_to_message;
  if (!message) return { text: "", imagePaths: [] };

  const parts = [];
  const author = message.from?.username ? `@${message.from.username}` : message.from?.first_name || "unknown";
  const body = message.text || message.caption || "";
  parts.push(`Replied-to Telegram message from ${author}:`);
  if (body) parts.push(body);
  else parts.push("[no text or caption]");

  const imagePaths = [];
  const photo = message.photo?.at(-1);
  if (photo) imagePaths.push(await downloadTelegramFile(ctx, photo.file_id, ".jpg"));
  const document = message.document;
  if (document?.mime_type?.startsWith("image/")) {
    const ext = path.extname(document.file_name ?? "") || extensionFromMime(document.mime_type);
    imagePaths.push(await downloadTelegramFile(ctx, document.file_id, ext));
  }

  if (imagePaths.length > 0) parts.push(`[attached ${imagePaths.length} replied-to image(s)]`);
  return { text: parts.join("\n"), imagePaths };
}

function mergeReplyContext(text, replyContext) {
  if (!replyContext.text) return text;
  return [
    "Use the following replied-to Telegram message as context.",
    "",
    "<replied_message>",
    replyContext.text,
    "</replied_message>",
    "",
    "<current_message>",
    text,
    "</current_message>"
  ].join("\n");
}

function applyPersonaPrompt(text) {
  const personaPrompt = effectivePersonaPrompt();
  if (!personaPrompt) return text;
  return [
    "<style_instruction>",
    personaPrompt,
    "</style_instruction>",
    "",
    text
  ].join("\n");
}

function effectivePersonaPrompt() {
  return config.codexPersonaPrompt || DEFAULT_PERSONA_PROMPTS[uiLanguage()] || DEFAULT_PERSONA_PROMPTS.en;
}

async function downloadTelegramFile(ctx, fileId, ext) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link.href);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(config.uploadDir, { recursive: true });
  const filename = `${Date.now()}-${fileId.replace(/[^a-zA-Z0-9_-]/g, "")}${ext}`;
  const filePath = path.join(config.uploadDir, filename);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function extensionFromMime(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}

function getChatKey(ctx) {
  return String(ctx.chat?.id ?? ctx.from?.id);
}

function commandName(ctx) {
  return (ctx.message?.text ?? "").trimStart().split(/\s+/, 1)[0]?.replace(/^\//, "") || "command";
}

function getCommandArgs(ctx) {
  const text = ctx.message?.text ?? "";
  const commandLength = text.trimStart().split(/\s+/, 1)[0]?.length ?? 0;
  return text.trimStart().slice(commandLength).trim();
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

async function loadState(file) {
  try {
    const data = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(data);
    return normalizeState(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeState({});
    throw error;
  }
}

function normalizeState(parsed) {
  const stateValue = parsed && typeof parsed === "object" ? parsed : {};
  return {
    ...stateValue,
    ui: {
      language: parseLanguage(stateValue.ui?.language || config.telegramLanguage),
      timeZone: parseTimeZone(stateValue.ui?.timeZone || config.telegramTimeZone),
      locale: parseLocale(stateValue.ui?.locale || config.telegramLocale)
    },
    runtime: stateValue.runtime && typeof stateValue.runtime === "object" ? sanitizeRuntimeSettings(stateValue.runtime) : {},
    chats: stateValue.chats && typeof stateValue.chats === "object" ? stateValue.chats : {},
    queues: stateValue.queues && typeof stateValue.queues === "object" ? stateValue.queues : {},
    cleanup: {
      lastDailyDate: stateValue.cleanup?.lastDailyDate ?? "",
      plans: stateValue.cleanup?.plans && typeof stateValue.cleanup.plans === "object" ? stateValue.cleanup.plans : {}
    },
    maintenance: {
      autoSqliteRepairEnabled: typeof stateValue.maintenance?.autoSqliteRepairEnabled === "boolean"
        ? stateValue.maintenance.autoSqliteRepairEnabled
        : config.codexMaintenanceAutoSqliteRepairEnabled,
      autoHandoffEnabled: typeof stateValue.maintenance?.autoHandoffEnabled === "boolean"
        ? stateValue.maintenance.autoHandoffEnabled
        : config.codexMaintenanceAutoHandoffEnabled
    },
    snapshots: {
      lastDailyDate: stateValue.snapshots?.lastDailyDate ?? ""
    }
  };
}

function sanitizeRuntimeSettings(value) {
  const sanitized = {};
  for (const [key, raw] of Object.entries(value || {})) {
    try {
      setRuntimeValue(sanitized, key, raw);
    } catch {
      // Ignore stale or invalid runtime overrides from older state files.
    }
  }
  return sanitized;
}

function runtimeValue(key) {
  return state.runtime?.[key] ?? config[key];
}

function runtimeSeconds(key) {
  return Math.round(Number(runtimeValue(key) || 0) / 1000);
}

function setRuntimeValue(target, key, rawValue) {
  if (rawValue == null || rawValue === "default") {
    delete target[key];
    return;
  }
  const value = String(rawValue).trim();
  if (key === "telegramReactionsEnabled" || key === "telegramLiveProgressEnabled" || key === "cleanupEnabled" || key === "snapshotEnabled") {
    target[key] = parseRequiredBoolean(value, key);
  } else if (key === "telegramFormatCodexAnswers") {
    target[key] = parseCodexAnswerFormat(value);
  } else if (key === "telegramLiveProgressMode") {
    if (!["brief", "korean-brief"].includes(value)) throw new Error("telegramLiveProgressMode must be brief or korean-brief.");
    target[key] = value;
  } else if (key === "cleanupNotifyTime" || key === "snapshotNotifyTime") {
    target[key] = parseTimeOfDay(value);
  } else if (key === "telegramCompletionNoticeSeconds" || key === "telegramPendingTurnsMax" || key === "telegramPendingTurnMaxAgeSeconds" || key === "cleanupRetentionDays" || key === "cleanupQuarantineDays" || key === "cleanupPlanTtlHours" || key === "snapshotRetentionDays" || key === "logsMaxLines" || key === "maxTelegramChars") {
    target[key] = parseStrictNonnegativeInteger(value, key);
  } else if (key === "telegramLiveProgressIntervalMs" || key === "progressEditIntervalMs") {
    const parsed = parseStrictNonnegativeInteger(value, key);
    target[key] = parsed >= 1000 ? parsed : parsed * 1000;
  } else {
    throw new Error(`Unknown runtime setting: ${key}`);
  }
}

async function updateRuntimeSetting(key, rawValue) {
  if (!state.runtime || typeof state.runtime !== "object") state.runtime = {};
  const value = String(rawValue || "").replaceAll("_", ":");
  setRuntimeValue(state.runtime, key, value);
  await saveState(config.stateFile, state);
}

function parseStrictNonnegativeInteger(value, label) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function parseTimeOfDay(value) {
  const normalized = String(value || "").trim().replaceAll("_", ":");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) throw new Error("Time must use HH:MM.");
  return normalized;
}

async function saveState(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function ensureDirectory(dir, label) {
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

async function listRecentCodexSessions(limit) {
  let files = [];
  try {
    files = await listFiles(config.codexSessionsDir);
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
    const firstLine = await readFirstLine(file);
    const parsed = JSON.parse(firstLine);
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
    files = await listFiles(config.codexSessionsDir);
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

async function createCleanupPlan(source) {
  pruneExpiredCleanupPlans();
  const sessionScan = await listCleanupSessionFiles(await collectProtectedThreadIds());
  const deleteCandidates = await listQuarantineDeleteCandidates();
  const maintenance = await readCodexMaintenanceReport().catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const createdAt = new Date();
  const plan = {
    id: `${createdAt.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + runtimeValue("cleanupPlanTtlHours") * 60 * 60 * 1000).toISOString(),
    retentionDays: runtimeValue("cleanupRetentionDays"),
    quarantineDays: runtimeValue("cleanupQuarantineDays"),
    protectedCount: sessionScan.protectedCount,
    recentCount: sessionScan.recentCount,
    quarantineCandidates: sessionScan.candidates,
    deleteCandidates,
    maintenance
  };
  state.cleanup.plans[plan.id] = plan;
  await appendCleanupLog({
    type: "plan",
    source,
    planId: plan.id,
    summary: summarizeCleanupPlan(plan),
    at: createdAt.toISOString()
  });
  return plan;
}

async function sendCleanupPlan(ctx, plan) {
  await replyHtml(ctx, formatCleanupPlanHtml(plan), cleanupKeyboard(plan.id));
}

async function sendDailyCleanupPlan() {
  const plan = await createCleanupPlan("daily");
  await saveState(config.stateFile, state);
  if (plan.quarantineCandidates.length === 0 && plan.deleteCandidates.length === 0) return;

  for (const chatId of config.cleanupNotifyChatIds) {
    try {
      await sendHtmlMessage(chatId, formatCleanupPlanHtml(plan), cleanupKeyboard(plan.id));
    } catch (error) {
      await appendCleanupLog({
        type: "notify_error",
        chatId,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
    }
  }
}

function cleanupKeyboard(planId) {
  const plan = state.cleanup?.plans?.[planId];
  const quarantineCount = plan?.quarantineCandidates?.length ?? 0;
  const deleteCount = plan?.deleteCandidates?.length ?? 0;
  return {
    reply_markup: {
      inline_keyboard: [
        [
          cleanupButton(`${uiLanguage() === "ko" ? "📦 격리만" : "📦 Quarantine only"} (${quarantineCount})`, `cleanup:quarantine:${planId}`, "primary"),
          cleanupButton(`${uiLanguage() === "ko" ? "🗑️ 영구 삭제" : "🗑️ Delete permanently"} (${deleteCount})`, `cleanup:delete:${planId}`, "danger")
        ],
        [
          cleanupButton(uiLanguage() === "ko" ? "⚠️ 둘 다 실행" : "⚠️ Run both", `cleanup:both:${planId}`, "danger"),
          cleanupButton(uiLanguage() === "ko" ? "✖️ 무시" : "✖️ Ignore", `cleanup:ignore:${planId}`, "primary")
        ]
      ]
    }
  };
}

function cleanupButton(text, callbackData, style) {
  return { text, callback_data: callbackData, style };
}

function formatCleanupPlanHtml(plan) {
  const quarantineBytes = sum(plan.quarantineCandidates.map((candidate) => candidate.bytes));
  const deleteBytes = sum(plan.deleteCandidates.map((candidate) => candidate.bytes));
  const lines = [
    b(uiLanguage() === "ko" ? "Codex thread cleanup 후보입니다." : "Codex thread cleanup candidates"),
    "",
    `${uiLanguage() === "ko" ? "격리 예정" : "To quarantine"}: ${code(`${plan.quarantineCandidates.length}${uiLanguage() === "ko" ? "개" : ""}`)} (${code(formatBytes(quarantineBytes))})`,
    `${uiLanguage() === "ko" ? "영구 삭제 예정" : "To delete permanently"}: ${code(`${plan.deleteCandidates.length}${uiLanguage() === "ko" ? "개" : ""}`)} (${code(formatBytes(deleteBytes))})`,
    "",
    b(uiLanguage() === "ko" ? "보호됨:" : "Protected:"),
    `- ${uiLanguage() === "ko" ? "현재 연결/실행 중 thread" : "Connected/running threads"}: ${code(`${plan.protectedCount}${uiLanguage() === "ko" ? "개" : ""}`)}`,
    `- ${uiLanguage() === "ko" ? `최근 ${plan.retentionDays}일 thread/log` : `Threads/logs from the last ${plan.retentionDays} days`}: ${code(`${plan.recentCount}${uiLanguage() === "ko" ? "개" : ""}`)}`,
    "",
    `${uiLanguage() === "ko" ? "격리 기준" : "Quarantine rule"}: ${code(uiLanguage() === "ko" ? `${plan.retentionDays}일 초과` : `older than ${plan.retentionDays} days`)}`,
    `${uiLanguage() === "ko" ? "삭제 기준" : "Delete rule"}: ${code(uiLanguage() === "ko" ? `격리 후 ${plan.quarantineDays}일 초과` : `older than ${plan.quarantineDays} days after quarantine`)}`,
    `${uiLanguage() === "ko" ? "승인 유효시간" : "Approval expires"}: ${code(formatDateTime(plan.expiresAt))}`
  ];
  lines.push(...formatCleanupMaintenanceSummaryLines(plan.maintenance));

  if (plan.quarantineCandidates.length > 0) {
    lines.push("", b(uiLanguage() === "ko" ? "격리 후보 샘플:" : "Quarantine sample:"));
    for (const candidate of plan.quarantineCandidates.slice(0, 5)) {
      lines.push(`- ${code(candidate.threadId)} (${code(`${candidate.ageDays}d`)}, ${code(formatBytes(candidate.bytes))})`);
    }
  }

  if (plan.deleteCandidates.length > 0) {
    lines.push("", b(uiLanguage() === "ko" ? "영구 삭제 후보 샘플:" : "Permanent delete sample:"));
    for (const candidate of plan.deleteCandidates.slice(0, 5)) {
      lines.push(`- ${code(candidate.threadId)} (${code(`${candidate.quarantineAgeDays}d quarantined`)}, ${code(formatBytes(candidate.bytes))})`);
    }
  }

  lines.push("", uiLanguage() === "ko" ? "중요 thread는 handoff 문서 작성 후 격리하세요." : "Create handoff docs before quarantining important threads.");
  lines.push(uiLanguage() === "ko" ? "버튼을 누를 때까지 파일은 이동/삭제되지 않습니다." : "No files move or delete until you press a button.");
  return lines.join("\n");
}

function summarizeCleanupPlan(plan) {
  return {
    quarantineCount: plan.quarantineCandidates.length,
    quarantineBytes: sum(plan.quarantineCandidates.map((candidate) => candidate.bytes)),
    deleteCount: plan.deleteCandidates.length,
    deleteBytes: sum(plan.deleteCandidates.map((candidate) => candidate.bytes)),
    protectedCount: plan.protectedCount,
    recentCount: plan.recentCount
  };
}

async function applyCleanupPlan(plan, action) {
  const result = { quarantined: 0, deleted: 0, skipped: 0, errors: [] };
  const artifact = await createCleanupArtifact(plan, action);
  result.artifactDir = artifact.dir;
  result.manifest = artifact.manifest;
  result.restoreScript = artifact.restoreScript;
  const operations = [];
  const protectedThreadIds = await collectProtectedThreadIds();
  const sessionsRoot = path.resolve(config.codexSessionsDir);

  if (action === "quarantine" || action === "both") {
    for (const candidate of plan.quarantineCandidates) {
      try {
        if (protectedThreadIds.has(candidate.threadId)) {
          result.skipped += 1;
          continue;
        }
        const sourcePath = path.resolve(candidate.path);
        if (!isPathInside(sourcePath, sessionsRoot)) {
          throw new Error(`Refusing to quarantine outside sessions dir: ${candidate.path}`);
        }
        const relativePath = path.relative(sessionsRoot, sourcePath);
        const targetPath = path.join(config.cleanupQuarantineDir, getLocalDateKey(), "sessions", relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(sourcePath, targetPath);
        await fs.writeFile(
          `${targetPath}.cleanup.json`,
          `${JSON.stringify({
            threadId: candidate.threadId,
            originalPath: candidate.path,
            quarantinedAt: new Date().toISOString()
          }, null, 2)}\n`,
          "utf8"
        );
        operations.push({ type: "quarantine", threadId: candidate.threadId, from: sourcePath, to: targetPath });
        result.quarantined += 1;
      } catch (error) {
        result.errors.push(`${candidate.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (action === "delete" || action === "both") {
    const quarantineRoot = path.resolve(config.cleanupQuarantineDir);
    for (const candidate of plan.deleteCandidates) {
      try {
        const deletePath = path.resolve(candidate.path);
        if (!isPathInside(deletePath, quarantineRoot)) {
          throw new Error(`Refusing to delete outside quarantine dir: ${candidate.path}`);
        }
        const relativePath = path.relative(quarantineRoot, deletePath);
        const backupPath = path.join(artifact.deleteBackupDir, relativePath);
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.cp(deletePath, backupPath, { recursive: true, force: true });
        await fs.cp(`${deletePath}.cleanup.json`, `${backupPath}.cleanup.json`, { force: true }).catch(() => {});
        await fs.rm(deletePath, { force: true });
        await fs.rm(`${deletePath}.cleanup.json`, { force: true });
        operations.push({ type: "delete", threadId: candidate.threadId, from: deletePath, backup: backupPath });
        result.deleted += 1;
      } catch (error) {
        result.errors.push(`${candidate.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await finalizeCleanupArtifact(artifact, operations, result);
  return result;
}

function formatCleanupMaintenanceSummaryLines(report) {
  if (!report) return [];
  if (!report.ok) {
    return ["", b(uiLanguage() === "ko" ? "Codex 유지보수 점검:" : "Codex maintenance check:"), `- report: ${code(report.error || "unavailable")}`];
  }
  const sessions = report.sessions || {};
  const logs = report.logs || {};
  const metadata = report.metadataBloat || {};
  const staleWorktrees = report.staleWorktrees || {};
  const configPrune = report.configPrune || {};
  return [
    "",
    b(uiLanguage() === "ko" ? "Codex 유지보수 점검:" : "Codex maintenance check:"),
    `- sessions: ${code(`${sessions.files ?? 0}${uiLanguage() === "ko" ? "개" : ""}`)} / ${code(formatBytes(sessions.bytes ?? 0))}`,
    `- logs: ${code(formatBytes(logs.bytes ?? 0))} / rotate ${code(`${logs.rotateThresholdMb ?? config.codexMaintenanceLogRotateMb}MB`)}`,
    `- stale worktrees: ${code(`${staleWorktrees.candidates ?? 0}${uiLanguage() === "ko" ? "개" : ""}`)}`,
    `- ${uiLanguage() === "ko" ? "config prune 후보" : "config prune candidates"}: ${code(`${configPrune.candidates ?? 0}${uiLanguage() === "ko" ? "개" : ""}`)}`,
    `- metadata bloat: title ${code(metadata.titlesOverLimit ?? 0)} / preview ${code(metadata.previewsOverLimit ?? 0)}`
  ];
}

async function createCleanupArtifact(plan, action) {
  const safePlanId = String(plan.id || "plan").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(config.cleanupArtifactDir, `${getLocalDateKey()}-${safePlanId}-${action}`);
  const deleteBackupDir = path.join(dir, "delete-backup");
  const manifest = path.join(dir, "manifest.jsonl");
  const restoreScript = path.join(dir, "restore-cleanup.py");
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(deleteBackupDir, { recursive: true });
  await fs.writeFile(path.join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(restoreScript, cleanupRestoreScript(manifest), "utf8");
  return { dir, deleteBackupDir, manifest, restoreScript };
}

async function finalizeCleanupArtifact(artifact, operations, result) {
  const lines = operations.map((operation) => JSON.stringify(operation));
  await fs.writeFile(artifact.manifest, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
  await fs.writeFile(path.join(artifact.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function cleanupRestoreScript(manifestPath) {
  return `#!/usr/bin/env python3
import json
import shutil
from pathlib import Path

manifest = Path(${JSON.stringify(manifestPath)})
for line in manifest.read_text(encoding="utf-8").splitlines():
    rec = json.loads(line)
    if rec.get("type") == "quarantine":
        src = Path(rec["to"])
        dest = Path(rec["from"])
        if src.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
    elif rec.get("type") == "delete":
        src = Path(rec["backup"])
        dest = Path(rec["from"])
        if src.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        meta = Path(str(src) + ".cleanup.json")
        if meta.exists():
            shutil.copy2(meta, Path(str(dest) + ".cleanup.json"))
`;
}

async function editCleanupMessage(ctx, html) {
  return editOrReplyHtml(ctx, html, { reply_markup: { inline_keyboard: [] } });
}

function cleanupActionLabel(action) {
  if (action === "quarantine") return "📦 격리";
  if (action === "delete") return "🗑️ 영구 삭제";
  if (action === "both") return "⚠️ 격리 + 영구 삭제";
  return action;
}

function formatCleanupIgnoredHtml(plan) {
  return [
    b("✖️ Codex thread cleanup 무시됨"),
    "",
    `격리 후보: ${code(`${plan.quarantineCandidates.length}개`)}`,
    `영구 삭제 후보: ${code(`${plan.deleteCandidates.length}개`)}`,
    "",
    "파일은 이동/삭제되지 않았습니다."
  ].join("\n");
}

function formatCleanupResultHtml(action, result, plan = null) {
  const lines = [
    b(`✅ Cleanup 처리 완료: ${cleanupActionLabel(action)}`),
    "",
    `격리 완료: ${code(result.quarantined)}`,
    `영구 삭제 완료: ${code(result.deleted)}`,
    `보호/스킵: ${code(result.skipped)}`,
    `오류: ${code(result.errors.length)}`,
    `manifest: ${code(result.manifest || "none")}`,
    `restore: ${code(result.restoreScript || "none")}`
  ];
  if (plan) {
    lines.push(
      "",
      b("처리 대상 요약:"),
      `- 격리 후보: ${code(`${plan.quarantineCandidates.length}개`)}`,
      `- 영구 삭제 후보: ${code(`${plan.deleteCandidates.length}개`)}`
    );
  }
  if (result.errors.length > 0) {
    lines.push("", ...result.errors.slice(0, 3).map((error) => `- ${code(error)}`));
  }
  return lines.join("\n");
}
async function listCleanupSessionFiles(protectedThreadIds) {
  let files = [];
  try {
    files = await listFiles(config.codexSessionsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return { protectedCount: protectedThreadIds.size, recentCount: 0, candidates: [] };
    throw error;
  }

  const cutoff = Date.now() - runtimeValue("cleanupRetentionDays") * 24 * 60 * 60 * 1000;
  const candidates = [];
  let recentCount = 0;

  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    const meta = await readSessionMeta(file);
    if (!meta?.id) continue;
    const stat = await fs.stat(file);
    if (protectedThreadIds.has(meta.id)) continue;
    if (stat.mtimeMs >= cutoff) {
      recentCount += 1;
      continue;
    }
    candidates.push({
      threadId: meta.id,
      path: file,
      modifiedAt: stat.mtime.toISOString(),
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000),
      bytes: stat.size
    });
  }

  candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
  return { protectedCount: protectedThreadIds.size, recentCount, candidates };
}

async function listQuarantineDeleteCandidates() {
  let files = [];
  try {
    files = await listFiles(config.cleanupQuarantineDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const cutoff = Date.now() - runtimeValue("cleanupQuarantineDays") * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const file of files.filter((entry) => entry.endsWith(".jsonl"))) {
    const stat = await fs.stat(file);
    const metadata = await readCleanupMetadata(file);
    const quarantinedAt = metadata?.quarantinedAt ? Date.parse(metadata.quarantinedAt) : stat.mtimeMs;
    if (Number.isNaN(quarantinedAt) || quarantinedAt >= cutoff) continue;
    const meta = await readSessionMeta(file);
    candidates.push({
      threadId: metadata?.threadId || meta?.id || path.basename(file, ".jsonl"),
      path: file,
      originalPath: metadata?.originalPath || "",
      quarantinedAt: new Date(quarantinedAt).toISOString(),
      quarantineAgeDays: Math.floor((Date.now() - quarantinedAt) / 86_400_000),
      bytes: stat.size
    });
  }

  candidates.sort((left, right) => left.quarantinedAt.localeCompare(right.quarantinedAt));
  return candidates;
}

async function readCleanupMetadata(file) {
  try {
    return JSON.parse(await fs.readFile(`${file}.cleanup.json`, "utf8"));
  } catch {
    return null;
  }
}

async function collectProtectedThreadIds() {
  const protectedThreadIds = new Set();
  for (const chat of Object.values(state.chats)) {
    if (chat?.threadId) protectedThreadIds.add(chat.threadId);
  }
  for (const thread of threadCache.values()) {
    if (thread?.id) protectedThreadIds.add(thread.id);
  }
  for (const threadId of await listRunningCodexThreadIds()) {
    protectedThreadIds.add(threadId);
  }
  return protectedThreadIds;
}

async function listRunningCodexThreadIds() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "args="], { maxBuffer: 2 * 1024 * 1024 });
    const ids = new Set();
    const idPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
    for (const line of stdout.split("\n")) {
      if (!line.toLowerCase().includes("codex")) continue;
      for (const match of line.matchAll(idPattern)) ids.add(match[0]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

function startCleanupScheduler() {
  setTimeout(() => {
    runDailyCleanupCheck().catch((error) => {
      console.error("cleanup scheduler failed", error);
    });
  }, 5000);
  setInterval(() => {
    runDailyCleanupCheck().catch((error) => {
      console.error("cleanup scheduler failed", error);
    });
  }, 60_000);
}

async function runDailyCleanupCheck() {
  if (!runtimeValue("cleanupEnabled")) return;
  const clock = getLocalClock();
  if (state.cleanup.lastDailyDate === clock.dateKey) return;
  if (clock.time < runtimeValue("cleanupNotifyTime")) return;

  await sendDailyCleanupPlan();
  await runAutomaticCodexMaintenanceIfEnabled();
  state.cleanup.lastDailyDate = clock.dateKey;
  pruneExpiredCleanupPlans();
  await saveState(config.stateFile, state);
}

async function runAutomaticCodexMaintenanceIfEnabled() {
  if (maintenanceAutoHandoffEnabled()) {
    const results = [];
    const seen = new Set();
    for (const chat of Object.values(state.chats)) {
      const threadId = chat?.threadId;
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      try {
        results.push(await createThreadHandoff(threadId));
      } catch (error) {
        results.push({ ok: false, threadId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await appendCleanupLog({ type: "auto_handoff", count: results.length, results, at: new Date().toISOString() });
  }

  if (maintenanceAutoSqliteRepairEnabled()) {
    if (activeTurns.size > 0) {
      await appendCleanupLog({ type: "auto_sqlite_repair_skipped", reason: "active_turns", count: activeTurns.size, at: new Date().toISOString() });
      return;
    }
    try {
      const result = await runCodexMaintenance("sqlite-metadata-repair");
      await appendCleanupLog({ type: "auto_sqlite_repair", result, at: new Date().toISOString() });
    } catch (error) {
      await appendCleanupLog({ type: "auto_sqlite_repair_error", message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    }
  }
}

function pruneExpiredCleanupPlans() {
  const now = Date.now();
  for (const [planId, plan] of Object.entries(state.cleanup.plans)) {
    if (!plan?.expiresAt || Date.parse(plan.expiresAt) < now) delete state.cleanup.plans[planId];
  }
}

async function appendCleanupLog(entry) {
  await fs.mkdir(path.dirname(config.cleanupLogFile), { recursive: true });
  await fs.appendFile(config.cleanupLogFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function startStateSnapshotScheduler() {
  setTimeout(() => {
    runDailyStateSnapshotCheck().catch((error) => {
      console.error("snapshot scheduler failed", error);
    });
  }, 10_000);
  setInterval(() => {
    runDailyStateSnapshotCheck().catch((error) => {
      console.error("snapshot scheduler failed", error);
    });
  }, 60_000);
}

async function runDailyStateSnapshotCheck() {
  if (!runtimeValue("snapshotEnabled")) return;
  const clock = getLocalClock();
  if (state.snapshots.lastDailyDate === clock.dateKey) return;
  if (clock.time < runtimeValue("snapshotNotifyTime")) return;

  await createStateBackup("daily-snapshot");
  state.snapshots.lastDailyDate = clock.dateKey;
  await saveState(config.stateFile, state);
}

async function createStateBackup(source) {
  await fs.mkdir(config.backupDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const payload = {
    createdAt,
    source,
    app: await buildAppSummary(),
    config: buildConfigSummary(),
    stats: {
      chats: Object.keys(state.chats).length,
      cleanupPlans: Object.keys(state.cleanup.plans).length,
      activeTurns: activeTurns.size,
      pendingTurns: countPendingTurns(),
      cachedThreads: threadCache.size
    },
    state,
    cleanupLog: await readOptionalText(config.cleanupLogFile)
  };
  const filePath = path.join(config.backupDir, `${timestampForFilename(createdAt)}-${source}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await pruneOldBackups();
  const stat = await fs.stat(filePath);
  return { path: filePath, bytes: stat.size, chatCount: payload.stats.chats };
}

async function createChatExport(chatKey) {
  await fs.mkdir(config.backupDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const chat = getChatState(chatKey);
  const payload = {
    createdAt,
    chatKey,
    chat,
    effectiveOptions: redactValue(getEffectiveOptions(chatKey)),
    activeTurn: activeTurns.has(chatKey),
    queuedTurns: getPendingTurns(chatKey).map(serializePendingTurn),
    cachedThreadId: threadCache.get(chatKey)?.id || ""
  };
  const filePath = path.join(config.backupDir, `${timestampForFilename(createdAt)}-chat-${safeFilename(chatKey)}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const stat = await fs.stat(filePath);
  return { path: filePath, bytes: stat.size };
}

async function pruneOldBackups() {
  let entries = [];
  try {
    entries = await fs.readdir(config.backupDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - runtimeValue("snapshotRetentionDays") * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(config.backupDir, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
  }
}

async function buildAppSummary() {
  const botPackage = await readJsonFile(path.join(appRoot, "package.json"));
  const sdkPackage = await readPackageJson("@openai/codex-sdk");
  return {
    botVersion: botPackage?.version || "",
    node: process.version,
    codexSdk: sdkPackage?.version || "",
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
}

function buildConfigSummary() {
  return redactValue({
    codexWorkdir: config.codexWorkdir,
    codexPath: config.codexPath,
    codexModel: config.codexModel,
    codexApprovalPolicy: config.codexApprovalPolicy,
    codexSandboxMode: config.codexSandboxMode,
    codexReasoningEffort: config.codexReasoningEffort,
    codexWebSearch: config.codexWebSearch,
    codexNetworkAccess: config.codexNetworkAccess,
    codexWebSearchEnabled: config.codexWebSearchEnabled,
    codexSkipGitRepoCheck: config.codexSkipGitRepoCheck,
    codexAdditionalDirectories: config.codexAdditionalDirectories,
    telegramLiveProgressEnabled: runtimeValue("telegramLiveProgressEnabled"),
    telegramLiveProgressIntervalSeconds: Math.round(runtimeValue("telegramLiveProgressIntervalMs") / 1000),
    telegramLiveProgressMode: runtimeValue("telegramLiveProgressMode"),
    telegramLiveProgressSource: config.telegramLiveProgressSource,
    telegramLiveProgressDeletePolicy: config.telegramLiveProgressDeletePolicy,
    telegramPendingTurnsMax: runtimeValue("telegramPendingTurnsMax"),
    telegramPendingTurnMaxAgeSeconds: runtimeValue("telegramPendingTurnMaxAgeSeconds"),
    telegramLanguage: config.telegramLanguage,
    telegramTimeZone: config.telegramTimeZone,
    telegramLocale: config.telegramLocale,
    codexBaseUrl: config.codexBaseUrl,
    codexApiKey: config.codexApiKey ? "set" : "",
    codexConfig: config.codexConfig ? "set" : "",
    codexEnv: config.codexEnv ? "set" : "",
    stateFile: config.stateFile,
    codexSessionsDir: config.codexSessionsDir,
    uploadDir: config.uploadDir,
    backupDir: config.backupDir,
    cleanupQuarantineDir: config.cleanupQuarantineDir,
    cleanupEnabled: runtimeValue("cleanupEnabled"),
    cleanupNotifyTime: runtimeValue("cleanupNotifyTime"),
    cleanupRetentionDays: runtimeValue("cleanupRetentionDays"),
    cleanupQuarantineDays: runtimeValue("cleanupQuarantineDays"),
    cleanupPlanTtlHours: runtimeValue("cleanupPlanTtlHours"),
    snapshotEnabled: runtimeValue("snapshotEnabled"),
    snapshotNotifyTime: runtimeValue("snapshotNotifyTime"),
    snapshotRetentionDays: runtimeValue("snapshotRetentionDays")
  });
}

function getLocalClock() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: uiTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function getLocalDateKey() {
  return getLocalClock().dateKey;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: uiTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(new Date(value)).replace(",", "");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${bytes} B`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readLatestTokenCount(threadId) {
  const file = await findCodexSessionFile(threadId);
  if (!file) return null;
  let latest = null;
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.payload?.type === "token_count") latest = parsed.payload;
    } catch {
      // Ignore partial or non-JSON session lines.
    }
  }
  return latest;
}

async function buildCodexUsageSummary(threadId) {
  const tokenCount = await readLatestTokenCount(threadId);
  if (!tokenCount) return "";
  const lines = [];
  const info = tokenCount.info;
  const usage = info?.total_token_usage;
  const window = info?.model_context_window;
  const used = usage?.total_tokens ?? usage?.input_tokens;
  if (typeof used === "number" && typeof window === "number" && window > 0) {
    const left = Math.max(0, Math.round((1 - used / window) * 100));
    lines.push(`Context: ${left}% left (${formatCompactNumber(used)} used / ${formatCompactNumber(window)})`);
  }

  const primary = tokenCount.rate_limits?.primary;
  if (primary) lines.push(`5h limit: ${formatLimitLeft(primary)}`);
  const secondary = tokenCount.rate_limits?.secondary;
  if (secondary) lines.push(`Weekly limit: ${formatLimitLeft(secondary)}`);
  return lines.length > 0 ? ["Codex usage:", ...lines].join("\n") : "";
}

function formatLimitLeft(limit) {
  const usedPercent = typeof limit.used_percent === "number" ? limit.used_percent : null;
  const left = usedPercent == null ? "unknown" : `${Math.max(0, Math.round(100 - usedPercent))}% left`;
  const reset = typeof limit.resets_at === "number" ? `, resets ${formatResetTime(limit.resets_at)} (${formatDurationUntil(limit.resets_at)} left)` : "";
  return `${left}${reset}`;
}

function formatResetTime(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat(uiLocale(), {
    timeZone: uiTimeZone(),
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(date).replace(",", "");
}

function formatDurationUntil(epochSeconds) {
  const ms = Math.max(0, epochSeconds * 1000 - Date.now());
  let minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function formatCompactNumber(value) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
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
  if (latest?.type === "command_execution") parts.push(`last: ${truncate(latest.command, 80)}`);
  if (latest?.type === "web_search") parts.push(`last: ${truncate(latest.query, 80)}`);
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
  const options = progressState?.chatKey ? getEffectiveOptions(progressState.chatKey) : defaultChatOptions();
  if (options.liveProgressDeletePolicy === "never") return false;
  if (options.liveProgressDeletePolicy === "on_success") return turnSucceeded;
  return true;
}

async function maybeSendLiveProgress(ctx, progressState, event, items) {
  if (!progressState) return;
  const options = getEffectiveOptions(progressState.chatKey || getChatKey(ctx));
  if (!options.liveProgressEnabled) return;
  if (!["brief", "korean-brief"].includes(runtimeValue("telegramLiveProgressMode"))) return;
  const progress = buildLiveProgressMessage(event, items, options.liveProgressSource, uiLanguage());
  if (!progress) return;
  if (progress.key === progressState.lastKey) return;

  const now = Date.now();
  const intervalMs = Math.max(0, runtimeValue("telegramLiveProgressIntervalMs"));
  if (!progress.important && progressState.lastSentAt > 0 && now - progressState.lastSentAt < intervalMs) return;

  progressState.lastSentAt = now;
  progressState.lastKey = progress.key;
  if (progressState.active) {
    progressState.active.lastProgress = stripHtml(progress.html);
    progressState.active.lastProgressAt = new Date(now).toISOString();
  }
  await replyTrackedProgressHtml(ctx, progressState, progress.html);
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
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;

  const item = event.item;
  if (!item) return null;

  if (item.type === "agent_message") {
    const text = String(item.text || "").trim();
    if (!text) return null;
    return {
      key: `agent-message-${item.id}-${hashString(text)}`,
      html: formatLiveAgentMessageHtml(text),
      important: event.type === "item.completed"
    };
  }
  return null;
}

function buildActivityLiveProgressMessage(event, items, language = "en") {
  const ko = language === "ko";
  if (event.type === "turn.started") {
    return { key: "turn-started", html: ko ? "작업 시작했어요. 요청을 분석하고 있습니다." : "Work started. Analyzing the request.", important: true };
  }
  if (event.type === "turn.completed") {
    return { key: "turn-completed", html: ko ? "작업을 마무리하고 최종 답변을 준비하고 있습니다." : "Wrapping up and preparing the final answer.", important: true };
  }
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;

  const item = event.item;
  if (!item) return null;
  if (item.type === "reasoning") {
    return { key: "reasoning", html: ko ? "요청을 분석하고 다음 작업을 정리하고 있습니다." : "Analyzing the request and planning the next step.", important: false };
  }
  if (item.type === "todo_list") {
    const remaining = item.items?.filter((todo) => !todo.completed).length ?? 0;
    return {
      key: `todo-${remaining}`,
      html: remaining > 0
        ? (ko ? `작업 순서를 정리했습니다. 남은 단계: ${code(remaining)}` : `Planned the work order. Remaining steps: ${code(remaining)}`)
        : (ko ? "작업 목록을 정리하고 있습니다." : "Organizing the task list."),
      important: false
    };
  }
  if (item.type === "command_execution") {
    const command = shortCommand(item.command || "");
    if (item.status === "failed") {
      return { key: `cmd-failed-${item.id}`, html: ko ? `명령 실행이 실패해서 확인하고 있습니다: ${code(command)}` : `Command failed; checking it now: ${code(command)}`, important: true };
    }
    if (item.status === "completed") {
      return { key: `cmd-done-${item.id}`, html: ko ? `명령 실행을 마쳤습니다: ${code(command)}` : `Command finished: ${code(command)}`, important: false };
    }
    return { key: `cmd-running-${item.id}`, html: ko ? `명령을 실행하고 있습니다: ${code(command)}` : `Running command: ${code(command)}`, important: false };
  }
  if (item.type === "file_change") {
    const paths = summarizeFileChangePaths(item);
    if (item.status === "failed") {
      return { key: `file-failed-${item.id}`, html: ko ? "파일 수정 적용이 실패해서 확인하고 있습니다." : "File change failed; checking it now.", important: true };
    }
    return { key: `file-done-${item.id}`, html: ko ? `파일을 수정했습니다: ${code(paths || "변경 파일")}` : `Updated files: ${code(paths || "changed files")}`, important: true };
  }
  if (item.type === "mcp_tool_call") {
    const tool = shortToolName(item);
    if (item.status === "failed") {
      return { key: `tool-failed-${item.id}`, html: ko ? `도구 실행이 실패해서 확인하고 있습니다: ${code(tool)}` : `Tool call failed; checking it now: ${code(tool)}`, important: true };
    }
    if (item.status === "completed") {
      return { key: `tool-done-${item.id}`, html: ko ? `도구 실행을 마쳤습니다: ${code(tool)}` : `Tool call finished: ${code(tool)}`, important: false };
    }
    return { key: `tool-running-${item.id}`, html: ko ? `도구를 실행하고 있습니다: ${code(tool)}` : `Running tool: ${code(tool)}`, important: false };
  }
  if (item.type === "web_search") {
    if (event.type === "item.completed") return { key: `web-done-${item.id}`, html: ko ? "웹 확인을 마쳤습니다." : "Web check finished.", important: false };
    return { key: `web-running-${item.id}`, html: ko ? "웹에서 필요한 정보를 확인하고 있습니다." : "Checking information on the web.", important: false };
  }
  if (item.type === "error") {
    return { key: `item-error-${item.id}`, html: ko ? "작업 중 오류 신호를 확인하고 있습니다." : "Checking an error signal from the task.", important: true };
  }
  if (item.type === "agent_message" && event.type !== "item.completed") {
    return { key: "agent-message-draft", html: ko ? "최종 답변을 작성하고 있습니다." : "Drafting the final answer.", important: false };
  }
  return null;
}

function formatLiveAgentMessageHtml(text) {
  const max = Math.min(Math.max(500, runtimeValue("maxTelegramChars")), 2000);
  const body = truncate(text.trim(), max);
  return runtimeValue("telegramFormatCodexAnswers") === "markdown"
    ? formatCodexAnswerMarkdownHtml(body)
    : formatCodexAnswerSafeHtml(body);
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function shortCommand(command) {
  return truncate(redactText(String(command || "").replace(/\s+/g, " ").trim()) || "command", 90);
}

function shortToolName(item) {
  return truncate([item.server, item.tool].filter(Boolean).join("/") || "tool", 80);
}

function summarizeFileChangePaths(item) {
  const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
  if (paths.length === 0) return "";
  const summary = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${summary}, +${paths.length - 3}` : summary;
}

async function sendCompletionNotice(ctx, turn, startedAt) {
  if (runtimeValue("telegramCompletionNoticeSeconds") <= 0) return;
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (elapsedSeconds < runtimeValue("telegramCompletionNoticeSeconds")) return;
  const counts = countBy(turn.items ?? [], (item) => item.type);
  const details = [];
  if (counts.command_execution) details.push(`cmd:${counts.command_execution}`);
  if (counts.file_change) details.push(`files:${counts.file_change}`);
  if (counts.web_search) details.push(`web:${counts.web_search}`);
  await replyHtml(ctx, `완료: ${code(formatDurationSeconds(elapsedSeconds))}${details.length > 0 ? ` (${code(details.join(", "))})` : ""}`);
}

async function sendModelSelection(ctx, chatKey) {
  const models = await listCodexModels();
  await replyHtml(ctx, formatModelSelectionHtml(chatKey, models), modelSelectionKeyboard(models));
}

async function sendReasoningSelection(ctx, chatKey) {
  await replyHtml(ctx, formatReasoningPromptHtml(chatKey), reasoningSelectionKeyboard());
}

async function sendPanel(ctx, panel, options = {}) {
  const chatKey = getChatKey(ctx);
  const edit = options.edit === true;
  let html = "";
  let keyboard = {};

  if (panel === "main") {
    html = await formatMainPanelHtml(chatKey);
    keyboard = mainPanelKeyboard(chatKey);
  } else if (panel === "status") {
    await pruneExpiredPendingTurns(chatKey, ctx);
    html = formatStatusHtml(chatKey, await buildStatusDetails(chatKey));
    keyboard = statusKeyboard(chatKey);
  } else if (panel === "queue") {
    await pruneExpiredPendingTurns(chatKey, ctx);
    html = formatQueueHtml(chatKey);
    keyboard = queueKeyboard(chatKey);
  } else if (panel === "settings") {
    html = settingsPanelHtml(chatKey);
    keyboard = settingsKeyboard();
  } else if (panel === "settings_model") {
    const models = await listCodexModels();
    html = formatModelSelectionHtml(chatKey, models);
    keyboard = withBackRow(modelSelectionKeyboard(models), "settings");
  } else if (panel === "settings_reasoning") {
    html = formatReasoningPromptHtml(chatKey);
    keyboard = withBackRow(reasoningSelectionKeyboard(), "settings");
  } else if (panel === "settings_fast") {
    html = await fastPanelHtml(chatKey);
    keyboard = fastKeyboard();
  } else if (panel === "settings_sandbox") {
    html = settingPanelHtml("Sandbox", getEffectiveOptions(chatKey).sandboxMode, t("sandboxDescription"));
    keyboard = sandboxKeyboard();
  } else if (panel === "settings_approval") {
    html = settingPanelHtml("Approval", getEffectiveOptions(chatKey).approvalPolicy, t("approvalDescription"));
    keyboard = approvalKeyboard();
  } else if (panel === "settings_web") {
    html = settingPanelHtml("Web Search", getEffectiveOptions(chatKey).webSearchMode, t("webDescription"));
    keyboard = webSearchKeyboard();
  } else if (panel === "settings_network") {
    html = settingPanelHtml("Network", formatOptional(getEffectiveOptions(chatKey).networkAccessEnabled), t("networkDescription"));
    keyboard = booleanOptionKeyboard("network");
  } else if (panel === "settings_stream") {
    html = settingPanelHtml("Stream", String(getEffectiveOptions(chatKey).streamEvents), t("streamDescription"));
    keyboard = booleanOptionKeyboard("stream");
  } else if (panel === "settings_live_progress") {
    html = liveProgressPanelHtml(chatKey);
    keyboard = liveProgressKeyboard(chatKey);
  } else if (panel === "settings_runtime") {
    html = runtimePanelHtml();
    keyboard = runtimeKeyboard();
  } else if (panel === "settings_runtime_output") {
    html = runtimeOutputPanelHtml();
    keyboard = runtimeOutputKeyboard();
  } else if (panel === "settings_runtime_queue") {
    html = runtimeQueuePanelHtml();
    keyboard = runtimeQueueKeyboard();
  } else if (panel === "settings_runtime_cleanup") {
    html = runtimeCleanupPanelHtml();
    keyboard = runtimeCleanupKeyboard();
  } else if (panel === "settings_runtime_snapshot") {
    html = runtimeSnapshotPanelHtml();
    keyboard = runtimeSnapshotKeyboard();
  } else if (panel === "settings_git") {
    html = settingPanelHtml("Git Check", String(getEffectiveOptions(chatKey).skipGitRepoCheck), t("gitDescription"));
    keyboard = booleanOptionKeyboard("skipgit");
  } else if (panel === "settings_paths") {
    html = pathsPanelHtml(chatKey);
    keyboard = pathsKeyboard();
  } else if (panel === "settings_schema") {
    html = schemaPanelHtml(chatKey);
    keyboard = schemaKeyboard();
  } else if (panel === "settings_language") {
    html = settingPanelHtml(t("languageTitle"), uiLanguage(), t("languageDescription"));
    keyboard = languageKeyboard();
  } else if (panel === "settings_timezone") {
    html = settingPanelHtml(t("timeZoneTitle"), uiTimeZone(), t("timeZoneDescription"));
    keyboard = timeZoneKeyboard();
  } else if (panel.startsWith("settings_timezone_")) {
    const groupId = panel.slice("settings_timezone_".length);
    html = timeZoneGroupPanelHtml(groupId);
    keyboard = timeZoneGroupKeyboard(groupId);
  } else if (panel === "settings_locale") {
    html = settingPanelHtml(t("localeTitle"), uiLocale(), t("localeDescription"));
    keyboard = localeKeyboard();
  } else if (panel === "tools") {
    html = toolsPanelHtml(chatKey);
    keyboard = toolsKeyboard();
  } else if (panel === "help") {
    html = helpTextHtml();
    keyboard = backToMainKeyboard();
  } else {
    html = await formatMainPanelHtml(chatKey);
    keyboard = mainPanelKeyboard(chatKey);
  }

  keyboard = withPreviousPanelButton(keyboard, previousPanelFor(panel));
  if (edit) return editOrReplyHtml(ctx, html, keyboard);
  return replyHtml(ctx, html, keyboard);
}

async function formatMainPanelHtml(chatKey) {
  const details = await buildStatusDetails(chatKey);
  const options = getEffectiveOptions(chatKey);
  return [
    b("Codex Control"),
    "",
    `Thread: ${code(details.threadId || "not started")}`,
    `Active turn: ${code(details.active ? "yes" : "no")}`,
    `Queue: ${code(`${details.queued} pending, mode=${details.queueMode}, paused=${details.queuePaused ? "yes" : "no"}`)}`,
    `Model: ${code(options.model || "default")}`,
    `Thinking: ${code(options.modelReasoningEffort)}`,
    `Workdir: ${code(options.workingDirectory)}`,
    "",
    t("mainInstruction")
  ].join("\n");
}

function settingsPanelHtml(chatKey) {
  return [
    b("Codex Settings"),
    "",
    formatOptionsHtml(chatKey),
    "",
    t("settingsInstruction")
  ].join("\n");
}

async function fastPanelHtml(chatKey) {
  return `${await formatFastStatusHtml(chatKey, await listCodexModels())}\n\n${t("fastInstruction")}`;
}

function settingPanelHtml(title, current, description) {
  return [
    b(uiLanguage() === "ko" ? `${title} 설정` : `${title} Settings`),
    `Current: ${code(current)}`,
    "",
    description
  ].join("\n");
}

function pathsPanelHtml(chatKey) {
  const options = getEffectiveOptions(chatKey);
  return [
    b(t("pathsTitle")),
    `Workdir: ${code(options.workingDirectory)}`,
    `Additional dirs: ${code((options.additionalDirectories ?? []).join(", ") || "none")}`,
    "",
    t("pathsDirect"),
    t("pathsButtons")
  ].join("\n");
}

function schemaPanelHtml(chatKey) {
  return [
    b("Structured Output Schema"),
    `Current: ${code(getChatState(chatKey).outputSchema ? "enabled" : "disabled")}`,
    "",
    t("schemaDirect"),
    t("schemaButtons")
  ].join("\n");
}

function liveProgressPanelHtml(chatKey) {
  const options = getEffectiveOptions(chatKey);
  return [
    b("Live Progress"),
    `Enabled: ${code(options.liveProgressEnabled)}`,
    `Source: ${code(options.liveProgressSource)}`,
    `Delete policy: ${code(options.liveProgressDeletePolicy)}`,
    `Mode: ${code(runtimeValue("telegramLiveProgressMode"))}`,
    `Interval: ${code(`${runtimeSeconds("telegramLiveProgressIntervalMs")}s`)}`,
    "",
    `${code("agent")}: ${t("liveAgent")}`,
    `${code("activity")}: ${t("liveActivity")}`,
    `${code("both")}: ${t("liveBoth")}`,
    `${code("never")}: ${t("liveNever")}`
  ].join("\n");
}

function runtimePanelHtml() {
  return [
    b(t("runtimeTitle")),
    "",
    runtimeSummaryHtml(),
    "",
    t("runtimeDescription")
  ].join("\n");
}

function runtimeSummaryHtml() {
  return formatKeyValueHtml("Runtime overrides:", [
    ["reactions", runtimeValue("telegramReactionsEnabled")],
    ["answer format", runtimeValue("telegramFormatCodexAnswers")],
    ["completion notice", `${runtimeValue("telegramCompletionNoticeSeconds")}s`],
    ["queue max", runtimeValue("telegramPendingTurnsMax")],
    ["queue expiry", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))],
    ["cleanup", runtimeValue("cleanupEnabled") ? `${runtimeValue("cleanupNotifyTime")} ${uiTimeZone()}` : "off"],
    ["snapshot", runtimeValue("snapshotEnabled") ? `${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}` : "off"],
    ["logs max lines", runtimeValue("logsMaxLines")],
    ["max message chars", runtimeValue("maxTelegramChars")]
  ]);
}

function runtimeOutputPanelHtml() {
  return formatKeyValueHtml("Output runtime:", [
    ["reactions", runtimeValue("telegramReactionsEnabled")],
    ["answer format", runtimeValue("telegramFormatCodexAnswers")],
    ["completion notice seconds", runtimeValue("telegramCompletionNoticeSeconds")],
    ["max Telegram chars", runtimeValue("maxTelegramChars")],
    ["logs max lines", runtimeValue("logsMaxLines")],
    ["progress edit interval", `${runtimeSeconds("progressEditIntervalMs")}s`]
  ]);
}

function runtimeQueuePanelHtml() {
  return formatKeyValueHtml("Queue runtime:", [
    ["pending turns max", runtimeValue("telegramPendingTurnsMax")],
    ["pending max age seconds", runtimeValue("telegramPendingTurnMaxAgeSeconds")],
    ["pending max age", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))]
  ]);
}

function runtimeCleanupPanelHtml() {
  return formatKeyValueHtml("Cleanup runtime:", [
    ["enabled", runtimeValue("cleanupEnabled")],
    ["notify time", `${runtimeValue("cleanupNotifyTime")} ${uiTimeZone()}`],
    ["retention days", runtimeValue("cleanupRetentionDays")],
    ["quarantine days", runtimeValue("cleanupQuarantineDays")],
    ["plan ttl hours", runtimeValue("cleanupPlanTtlHours")]
  ]);
}

function runtimeSnapshotPanelHtml() {
  return formatKeyValueHtml("Snapshot runtime:", [
    ["enabled", runtimeValue("snapshotEnabled")],
    ["notify time", `${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}`],
    ["retention days", runtimeValue("snapshotRetentionDays")]
  ]);
}

function toolsPanelHtml(chatKey) {
  const chat = getChatState(chatKey);
  return [
    b("Codex Tools"),
    "",
    `Thread: ${code(chat.threadId || threadCache.get(chatKey)?.id || "not started")}`,
    `Saved chats: ${code(Object.keys(state.chats).length)}`,
    `Pending turns: ${code(countPendingTurns())}`,
    "",
    t("toolsInstruction")
  ].join("\n");
}

function mainPanelKeyboard(chatKey) {
  const rows = [
    [
      { text: t("status"), callback_data: "p:status" },
      { text: t("queue"), callback_data: "p:queue" }
    ],
    [
      { text: t("settings"), callback_data: "p:settings" },
      { text: t("tools"), callback_data: "p:tools" }
    ],
    [
      { text: t("newThread"), callback_data: "act:new" },
      { text: t("resumeLast"), callback_data: "act:resume_last" }
    ],
    [
      { text: activeTurns.has(chatKey) ? t("stop") : t("help"), callback_data: activeTurns.has(chatKey) ? "act:stop" : "p:help" }
    ]
  ];
  return inlineKeyboard(rows);
}

function statusKeyboard(chatKey) {
  const rows = [
    [
      { text: t("refresh"), callback_data: "p:status" },
      { text: t("queue"), callback_data: "p:queue" }
    ],
    [
      { text: t("settings"), callback_data: "p:settings" },
      { text: t("main"), callback_data: "p:main" }
    ]
  ];
  if (activeTurns.has(chatKey) || getSideTurnCount(chatKey) > 0) {
    rows.splice(1, 0, [{ text: t("stop"), callback_data: "act:stop" }]);
  }
  rows.push([{ text: `← ${t("back")}`, callback_data: "p:main" }]);
  return inlineKeyboard(rows);
}

function settingsKeyboard() {
  return inlineKeyboard([
    [
      { text: t("model"), callback_data: "p:settings_model" },
      { text: "Thinking", callback_data: "p:settings_reasoning" }
    ],
    [
      { text: "Fast", callback_data: "p:settings_fast" },
      { text: "Sandbox", callback_data: "p:settings_sandbox" }
    ],
    [
      { text: "Approval", callback_data: "p:settings_approval" },
      { text: "Web Search", callback_data: "p:settings_web" }
    ],
    [
      { text: "Network", callback_data: "p:settings_network" },
      { text: "Stream", callback_data: "p:settings_stream" }
    ],
    [
      { text: "Live Progress", callback_data: "p:settings_live_progress" }
    ],
    [
      { text: t("runtime"), callback_data: "p:settings_runtime" }
    ],
    [
      { text: "Git Check", callback_data: "p:settings_git" },
      { text: "Paths", callback_data: "p:settings_paths" }
    ],
    [
      { text: "Schema", callback_data: "p:settings_schema" },
      { text: t("prefsReset"), callback_data: "confirm:prefs_reset" }
    ],
    [
      { text: t("language"), callback_data: "p:settings_language" },
      { text: t("timeZone"), callback_data: "p:settings_timezone" }
    ],
    [
      { text: t("locale"), callback_data: "p:settings_locale" },
      { text: t("main"), callback_data: "p:main" }
    ],
    [{ text: `← ${t("back")}`, callback_data: "p:main" }]
  ]);
}

function fastKeyboard() {
  return inlineKeyboard([
    [
      { text: t("on"), callback_data: "set:fast:on" },
      { text: t("off"), callback_data: "set:fast:off" }
    ],
    [
      { text: t("settings"), callback_data: "p:settings" },
      { text: t("main"), callback_data: "p:main" }
    ]
  ]);
}

function sandboxKeyboard() {
  return inlineKeyboard([
    [
      { text: "default", callback_data: "set:sandbox:default" },
      { text: "read-only", callback_data: "set:sandbox:ro" }
    ],
    [
      { text: "workspace-write", callback_data: "set:sandbox:ww" },
      { text: "danger-full-access", callback_data: "set:sandbox:danger" }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function approvalKeyboard() {
  return inlineKeyboard([
    [
      { text: "default", callback_data: "set:approval:default" },
      { text: "never", callback_data: "set:approval:never" }
    ],
    [
      { text: "on-request", callback_data: "set:approval:on_request" },
      { text: "on-failure", callback_data: "set:approval:on_failure" }
    ],
    [
      { text: "untrusted", callback_data: "set:approval:untrusted" },
      { text: t("settings"), callback_data: "p:settings" }
    ]
  ]);
}

function webSearchKeyboard() {
  return inlineKeyboard([
    [
      { text: "default", callback_data: "set:web:default" },
      { text: "disabled", callback_data: "set:web:disabled" }
    ],
    [
      { text: "cached", callback_data: "set:web:cached" },
      { text: "live", callback_data: "set:web:live" }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function booleanOptionKeyboard(key) {
  return inlineKeyboard([
    [
      { text: "default", callback_data: `set:${key}:default` },
      { text: "on", callback_data: `set:${key}:on` },
      { text: "off", callback_data: `set:${key}:off` }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function liveProgressKeyboard() {
  return inlineKeyboard([
    [
      { text: t("on"), callback_data: "set:liveprogress:on" },
      { text: t("off"), callback_data: "set:liveprogress:off" },
      { text: t("default"), callback_data: "set:liveprogress:default" }
    ],
    [
      { text: uiLanguage() === "ko" ? "Codex 코멘트" : "Codex comments", callback_data: "set:liveprogresssource:agent" },
      { text: uiLanguage() === "ko" ? "작업 활동" : "Activity", callback_data: "set:liveprogresssource:activity" },
      { text: uiLanguage() === "ko" ? "둘 다" : "Both", callback_data: "set:liveprogresssource:both" }
    ],
    [
      { text: uiLanguage() === "ko" ? "항상 삭제" : "Always delete", callback_data: "set:liveprogressdelete:always" },
      { text: uiLanguage() === "ko" ? "성공 시 삭제" : "Delete on success", callback_data: "set:liveprogressdelete:on_success" },
      { text: uiLanguage() === "ko" ? "모두 남김" : "Keep all", callback_data: "set:liveprogressdelete:never" }
    ],
    [
      { text: uiLanguage() === "ko" ? "출력 기본값" : "Source default", callback_data: "set:liveprogresssource:default" },
      { text: uiLanguage() === "ko" ? "삭제 기본값" : "Delete default", callback_data: "set:liveprogressdelete:default" }
    ],
    [
      { text: "brief", callback_data: "set:runtime_liveprogressmode:brief" },
      { text: "legacy ko", callback_data: "set:runtime_liveprogressmode:korean_brief" },
      { text: t("default"), callback_data: "set:runtime_liveprogressmode:default" }
    ],
    [
      { text: "10s", callback_data: "set:runtime_liveprogressinterval:10" },
      { text: "30s", callback_data: "set:runtime_liveprogressinterval:30" },
      { text: "60s", callback_data: "set:runtime_liveprogressinterval:60" },
      { text: t("default"), callback_data: "set:runtime_liveprogressinterval:default" }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
  ]);
}

function runtimeKeyboard() {
  return inlineKeyboard([
    [
      { text: t("output"), callback_data: "p:settings_runtime_output" },
      { text: t("queue"), callback_data: "p:settings_runtime_queue" }
    ],
    [
      { text: t("cleanup"), callback_data: "p:settings_runtime_cleanup" },
      { text: t("snapshots"), callback_data: "p:settings_runtime_snapshot" }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
    [{ text: `← ${t("back")}`, callback_data: "p:settings" }]
  ]);
}

function runtimeOutputKeyboard() {
  return inlineKeyboard([
    [
      { text: "Reactions on", callback_data: "set:runtime_reactions:on" },
      { text: "off", callback_data: "set:runtime_reactions:off" },
      { text: t("default"), callback_data: "set:runtime_reactions:default" }
    ],
    [
      { text: "Markdown", callback_data: "set:runtime_answerformat:markdown" },
      { text: "Safe", callback_data: "set:runtime_answerformat:safe" },
      { text: "Plain", callback_data: "set:runtime_answerformat:off" },
      { text: t("default"), callback_data: "set:runtime_answerformat:default" }
    ],
    [
      { text: "Notice off", callback_data: "set:runtime_completionnotice:0" },
      { text: "90s", callback_data: "set:runtime_completionnotice:90" },
      { text: "180s", callback_data: "set:runtime_completionnotice:180" },
      { text: t("default"), callback_data: "set:runtime_completionnotice:default" }
    ],
    [
      { text: "Chars 2000", callback_data: "set:runtime_maxchars:2000" },
      { text: "3500", callback_data: "set:runtime_maxchars:3500" },
      { text: "4000", callback_data: "set:runtime_maxchars:4000" },
      { text: t("default"), callback_data: "set:runtime_maxchars:default" }
    ],
    [
      { text: "Logs 40", callback_data: "set:runtime_logsmax:40" },
      { text: "80", callback_data: "set:runtime_logsmax:80" },
      { text: "160", callback_data: "set:runtime_logsmax:160" },
      { text: t("default"), callback_data: "set:runtime_logsmax:default" }
    ],
    [
      { text: "Edit 4s", callback_data: "set:runtime_progressedit:4" },
      { text: "8s", callback_data: "set:runtime_progressedit:8" },
      { text: "15s", callback_data: "set:runtime_progressedit:15" },
      { text: t("default"), callback_data: "set:runtime_progressedit:default" }
    ],
    [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function runtimeQueueKeyboard() {
  return inlineKeyboard([
    [
      { text: "Max 5", callback_data: "set:runtime_pendingmax:5" },
      { text: "10", callback_data: "set:runtime_pendingmax:10" },
      { text: "25", callback_data: "set:runtime_pendingmax:25" },
      { text: t("default"), callback_data: "set:runtime_pendingmax:default" }
    ],
    [
      { text: "Expiry off", callback_data: "set:runtime_pendingage:0" },
      { text: "1h", callback_data: "set:runtime_pendingage:3600" },
      { text: "2h", callback_data: "set:runtime_pendingage:7200" },
      { text: "24h", callback_data: "set:runtime_pendingage:86400" },
      { text: t("default"), callback_data: "set:runtime_pendingage:default" }
    ],
    [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function runtimeCleanupKeyboard() {
  return inlineKeyboard([
    [
      { text: t("on"), callback_data: "set:runtime_cleanup:on" },
      { text: t("off"), callback_data: "set:runtime_cleanup:off" },
      { text: t("default"), callback_data: "set:runtime_cleanup:default" }
    ],
    timePresetButtons("runtime_cleanuptime"),
    [
      { text: "Keep 7d", callback_data: "set:runtime_cleanupretention:7" },
      { text: "14d", callback_data: "set:runtime_cleanupretention:14" },
      { text: "30d", callback_data: "set:runtime_cleanupretention:30" },
      { text: t("default"), callback_data: "set:runtime_cleanupretention:default" }
    ],
    [
      { text: "Q 7d", callback_data: "set:runtime_cleanupquarantine:7" },
      { text: "14d", callback_data: "set:runtime_cleanupquarantine:14" },
      { text: "30d", callback_data: "set:runtime_cleanupquarantine:30" },
      { text: t("default"), callback_data: "set:runtime_cleanupquarantine:default" }
    ],
    [
      { text: "TTL 12h", callback_data: "set:runtime_cleanupttl:12" },
      { text: "24h", callback_data: "set:runtime_cleanupttl:24" },
      { text: "48h", callback_data: "set:runtime_cleanupttl:48" },
      { text: t("default"), callback_data: "set:runtime_cleanupttl:default" }
    ],
    [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function runtimeSnapshotKeyboard() {
  return inlineKeyboard([
    [
      { text: t("on"), callback_data: "set:runtime_snapshot:on" },
      { text: t("off"), callback_data: "set:runtime_snapshot:off" },
      { text: t("default"), callback_data: "set:runtime_snapshot:default" }
    ],
    timePresetButtons("runtime_snapshottime"),
    [
      { text: "Keep 7d", callback_data: "set:runtime_snapshotretention:7" },
      { text: "14d", callback_data: "set:runtime_snapshotretention:14" },
      { text: "30d", callback_data: "set:runtime_snapshotretention:30" },
      { text: t("default"), callback_data: "set:runtime_snapshotretention:default" }
    ],
    [{ text: t("runtime"), callback_data: "p:settings_runtime" }, { text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function timePresetButtons(key) {
  return [
    ...TIME_PRESET_CHOICES.map(([id, label]) => ({ text: label, callback_data: `set:${key}:${id}` })),
    { text: t("default"), callback_data: `set:${key}:default` }
  ];
}

function pathsKeyboard() {
  return inlineKeyboard([
    [
      { text: "workdir default", callback_data: "set:workdir:default" },
      { text: t("clearDirs"), callback_data: "set:dirs:clear" }
    ],
    [{ text: t("settings"), callback_data: "p:settings" }]
  ]);
}

function schemaKeyboard() {
  return inlineKeyboard([
    [
      { text: t("schemaOff"), callback_data: "set:schema:off" },
      { text: t("settings"), callback_data: "p:settings" }
    ]
  ]);
}

function languageKeyboard() {
  const current = uiLanguage();
  return inlineKeyboard([
    ...chunkButtons(LANGUAGE_CHOICES.map(({ code: languageCode, emoji, nativeName }) => ({
      text: `${current === languageCode ? "✅ " : ""}${emoji} ${nativeName}`,
      callback_data: `set:language:${languageCode}`,
      style: current === languageCode ? "success" : "primary"
    })), 2),
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
  ]);
}

function chunkButtons(buttons, size) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += size) rows.push(buttons.slice(index, index + size));
  return rows;
}

function timeZoneKeyboard() {
  return inlineKeyboard([
    ...chunkButtons(TIME_ZONE_GROUPS.map(([id, emoji, label]) => ({
      text: `${emoji} ${label}`,
      callback_data: `p:settings_timezone_${id}`
    })), 2),
    [{ text: t("default"), callback_data: "set:timezone:default" }],
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
  ]);
}

function timeZoneGroupKeyboard(groupId) {
  const choices = timeZoneChoicesForGroup(groupId);
  const columns = groupId === "utc" ? 2 : 1;
  return inlineKeyboard([
    ...chunkButtons(choices.map(([id, label, timeZone]) => ({
      text: uiTimeZone() === timeZone ? `✅ ${formatTimeZoneChoiceLabel(label, timeZone)}` : formatTimeZoneChoiceLabel(label, timeZone),
      callback_data: `set:timezone:${id}`
    })), columns),
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }],
    [{ text: `← ${t("back")}`, callback_data: "p:settings_timezone" }]
  ]);
}

function timeZoneChoicesForGroup(groupId) {
  if (groupId === "utc") return UTC_OFFSET_TIME_ZONE_CHOICES;
  return REGIONAL_TIME_ZONE_CHOICES[groupId] ?? [];
}

function timeZoneGroupPanelHtml(groupId) {
  const group = TIME_ZONE_GROUPS.find(([id]) => id === groupId);
  if (!group) return settingPanelHtml(t("timeZoneTitle"), uiTimeZone(), t("timeZoneDescription"));
  const [, emoji, label] = group;
  const description = groupId === "utc" ? t("timeZoneUtcDescription") : t("timeZoneRegionDescription");
  return settingPanelHtml(`${t("timeZoneTitle")} · ${emoji} ${label}`, uiTimeZone(), description);
}

function formatTimeZoneChoiceLabel(label, timeZone) {
  if (/^UTC[+-]\d{2}$/.test(label) || label === "UTC+00") return label;
  return `${formatUtcOffset(timeZone)} ${label}`;
}

function formatUtcOffset(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "shortOffset"
    }).formatToParts(new Date());
    const name = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
    if (name === "GMT" || name === "UTC") return "UTC+00";
    const match = name.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return name.replace(/^GMT/, "UTC");
    const [, sign, hour, minute = "00"] = match;
    return `UTC${sign}${hour.padStart(2, "0")}${minute === "00" ? "" : `:${minute}`}`;
  } catch {
    return "UTC";
  }
}

function localeKeyboard() {
  return inlineKeyboard([
    ...chunkButtons(LOCALE_CHOICES.map(([id, label, locale]) => ({
      text: uiLocale() === locale ? `✅ ${label}` : label,
      callback_data: `set:locale:${id}`
    })), 2),
    [{ text: t("default"), callback_data: "set:locale:default" }],
    [{ text: t("settings"), callback_data: "p:settings" }, { text: t("main"), callback_data: "p:main" }]
  ]);
}

function toolsKeyboard() {
  return inlineKeyboard([
    [
      { text: "Health", callback_data: "tool:health" },
      { text: "Doctor", callback_data: "tool:doctor" }
    ],
    [
      { text: "Logs", callback_data: "tool:logs" },
      { text: "Error logs", callback_data: "tool:logs_error" }
    ],
    [
      { text: "Whoami", callback_data: "tool:whoami" },
      { text: "Config", callback_data: "tool:config" }
    ],
    [
      { text: "Backup", callback_data: "tool:backup" },
      { text: "Export", callback_data: "tool:export" }
    ],
    [
      { text: "Cleanup", callback_data: "tool:cleanup" },
      { text: "Forget", callback_data: "tool:forget" }
    ],
    [
      { text: t("codexMaintenance"), callback_data: "tool:codex_maintenance", style: "primary" }
    ],
    [{ text: t("main"), callback_data: "p:main" }],
    [{ text: `← ${t("back")}`, callback_data: "p:main" }]
  ]);
}

function backToMainKeyboard() {
  return inlineKeyboard([[{ text: t("main"), callback_data: "p:main" }]]);
}

function withBackRow(keyboard, panel) {
  const rows = keyboard?.reply_markup?.inline_keyboard ? [...keyboard.reply_markup.inline_keyboard] : [];
  rows.push([{ text: t("settings"), callback_data: `p:${panel}` }, { text: t("main"), callback_data: "p:main" }]);
  return inlineKeyboard(rows);
}

function withPreviousPanelButton(keyboard, previousPanel) {
  if (!previousPanel) return keyboard;
  const callbackData = `p:${previousPanel}`;
  const rows = keyboard?.reply_markup?.inline_keyboard ? [...keyboard.reply_markup.inline_keyboard] : [];
  const hasPreviousButton = rows.some((row) => row.some((button) => (
    button?.callback_data === callbackData && String(button.text || "").includes("←")
  )));
  if (!hasPreviousButton) rows.push([{ text: `← ${t("back")}`, callback_data: callbackData }]);
  return inlineKeyboard(rows);
}

function previousPanelFor(panel) {
  if (panel === "main") return null;
  if (["status", "queue", "settings", "tools", "help"].includes(panel)) return "main";
  if (panel.startsWith("settings_timezone_")) return "settings_timezone";
  if (panel.startsWith("settings_runtime_")) return "settings_runtime";
  if (panel.startsWith("settings_")) return "settings";
  return "main";
}

function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

async function handleQueueButton(ctx, action, value) {
  const chatKey = getChatKey(ctx);
  await pruneExpiredPendingTurns(chatKey, ctx);
  if (action === "pause") {
    await setQueuePaused(chatKey, true);
    await editOrReplyHtml(ctx, `${b(t("queuePausedTitle"))}\n${t("queuePausedDetail")}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "resume") {
    await setQueuePaused(chatKey, false);
    await startQueueDrainIfIdle(chatKey, ctx);
    await editOrReplyHtml(ctx, `${b(t("queueResumedTitle"))}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "mode") {
    if (!VALID.queueMode.has(value)) {
      await editOrReplyHtml(ctx, `${b("Invalid queue mode")}\n${code(value || "empty")}`, queueKeyboard(chatKey));
      return;
    }
    await setQueueMode(chatKey, value);
    await editOrReplyHtml(ctx, `${b(t("queueUpdatedTitle"))}\n\n${formatQueueHtml(chatKey)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "clear") {
    await editOrReplyHtml(ctx, `${b(t("queueClearConfirmTitle"))}\n${t("queueClearConfirmBody")}`, inlineKeyboard([
      [
        { text: t("clearAll"), callback_data: "confirm:q_clear" },
        { text: t("cancel"), callback_data: "p:queue" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:queue" }]
    ]));
  }
}

async function handleSettingButton(ctx, key, value) {
  const chatKey = getChatKey(ctx);
  if (await rejectCallbackIfActive(ctx, chatKey)) return;
  try {
    if (key === "fast") await setOption(chatKey, "serviceTier", value === "on" ? "fast" : "default");
    else if (key === "sandbox") await setOption(chatKey, "sandboxMode", mapSandboxValue(value));
    else if (key === "approval") await setOption(chatKey, "approvalPolicy", value.replaceAll("_", "-"));
    else if (key === "web") await setOption(chatKey, "webSearchMode", value);
    else if (key === "network") await setOption(chatKey, "networkAccessEnabled", value);
    else if (key === "stream") await setOption(chatKey, "streamEvents", value);
    else if (key === "liveprogress") await setOption(chatKey, "liveProgressEnabled", value);
    else if (key === "liveprogresssource") await setOption(chatKey, "liveProgressSource", value);
    else if (key === "liveprogressdelete") await setOption(chatKey, "liveProgressDeletePolicy", value);
    else if (key.startsWith("runtime_")) {
      await updateRuntimeSetting(runtimeSettingKey(key), runtimeSettingValue(key, value));
      await editOrReplyHtml(ctx, `${b(t("runtimeUpdated"))}\n\n${runtimePanelHtml()}`, runtimeKeyboard());
      return;
    }
    else if (key === "skipgit") await setOption(chatKey, "skipGitRepoCheck", value);
    else if (key === "workdir") await setOption(chatKey, "workingDirectory", value);
    else if (key === "language") {
      state.ui.language = parseLanguage(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("languageUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      await registerTelegramCommands().catch((error) => console.warn("setMyCommands after language update failed:", error instanceof Error ? error.message : String(error)));
      return;
    }
    else if (key === "timezone") {
      state.ui.timeZone = value === "default" ? config.telegramTimeZone : timeZoneFromChoice(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("timeZoneUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      return;
    }
    else if (key === "locale") {
      state.ui.locale = value === "default" ? config.telegramLocale : localeFromChoice(value);
      await saveState(config.stateFile, state);
      await editOrReplyHtml(ctx, `${b(t("localeUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
      return;
    }
    else if (key === "dirs" && value === "clear") {
      delete getChatState(chatKey).options.additionalDirectories;
      invalidateThreadCache(chatKey);
    } else if (key === "schema" && value === "off") {
      delete getChatState(chatKey).outputSchema;
    } else {
      throw new Error(`Unknown setting action: ${key}:${value}`);
    }
  } catch (error) {
    await editOrReplyHtml(ctx, `${b(t("settingFailure"))}\n${code(error instanceof Error ? error.message : String(error))}`, settingsKeyboard());
    return;
  }
  await saveState(config.stateFile, state);
  await editOrReplyHtml(ctx, `${b(t("settingUpdated"))}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
}

function mapSandboxValue(value) {
  if (value === "ro") return "read-only";
  if (value === "ww") return "workspace-write";
  if (value === "danger") return "danger-full-access";
  return value;
}

function timeZoneFromChoice(id) {
  const choice = TIME_ZONE_CHOICES.find(([choiceId]) => choiceId === id);
  if (!choice) throw new Error(`Unknown time zone: ${id}`);
  return parseTimeZone(choice[2]);
}

function localeFromChoice(id) {
  const choice = LOCALE_CHOICES.find(([choiceId]) => choiceId === id);
  if (!choice) throw new Error(`Unknown locale: ${id}`);
  return parseLocale(choice[2]);
}

function runtimeSettingKey(actionKey) {
  const map = {
    runtime_reactions: "telegramReactionsEnabled",
    runtime_answerformat: "telegramFormatCodexAnswers",
    runtime_completionnotice: "telegramCompletionNoticeSeconds",
    runtime_pendingmax: "telegramPendingTurnsMax",
    runtime_pendingage: "telegramPendingTurnMaxAgeSeconds",
    runtime_liveprogressmode: "telegramLiveProgressMode",
    runtime_liveprogressinterval: "telegramLiveProgressIntervalMs",
    runtime_cleanup: "cleanupEnabled",
    runtime_cleanuptime: "cleanupNotifyTime",
    runtime_cleanupretention: "cleanupRetentionDays",
    runtime_cleanupquarantine: "cleanupQuarantineDays",
    runtime_cleanupttl: "cleanupPlanTtlHours",
    runtime_snapshot: "snapshotEnabled",
    runtime_snapshottime: "snapshotNotifyTime",
    runtime_snapshotretention: "snapshotRetentionDays",
    runtime_logsmax: "logsMaxLines",
    runtime_maxchars: "maxTelegramChars",
    runtime_progressedit: "progressEditIntervalMs"
  };
  const key = map[actionKey];
  if (!key) throw new Error(`Unknown runtime action: ${actionKey}`);
  return key;
}

function runtimeSettingValue(actionKey, value) {
  if (value === "korean_brief") return "korean-brief";
  if (actionKey === "runtime_cleanuptime" || actionKey === "runtime_snapshottime") return value.replaceAll("_", ":");
  return value;
}

async function handleToolButton(ctx, action) {
  const chatKey = getChatKey(ctx);
  if (action === "health") {
    await editOrReplyHtml(ctx, await formatHealthHtml(), withToolsBack());
  } else if (action === "doctor") {
    await editOrReplyHtml(ctx, await formatDoctorHtml(chatKey), withToolsBack());
  } else if (action === "logs") {
    await editOrReplyHtml(ctx, await formatLogsHtml(ctx), withToolsBack());
  } else if (action === "logs_error") {
    await editOrReplyHtml(ctx, await formatLogsHtml(ctx, "error"), withToolsBack());
  } else if (action === "whoami") {
    await editOrReplyHtml(ctx, formatWhoamiHtml(ctx), withToolsBack());
  } else if (action === "config") {
    await editOrReplyHtml(ctx, formatConfigHtml(), withToolsBack());
  } else if (action === "backup") {
    const backup = await createStateBackup("manual");
    await replyHtml(ctx, formatKeyValueHtml("Backup created:", [
      ["file", backup.path],
      ["size", formatBytes(backup.bytes)],
      ["chats", backup.chatCount]
    ]));
    await replyDocumentQuietly(ctx, backup.path, "Codex Telegram Bot backup");
  } else if (action === "export") {
    const file = await createChatExport(chatKey);
    await replyHtml(ctx, formatKeyValueHtml("Chat export created:", [
      ["file", file.path],
      ["size", formatBytes(file.bytes)]
    ]));
    await replyDocumentQuietly(ctx, file.path, "Current chat export");
  } else if (action === "cleanup") {
    await handleCleanupCommand(ctx);
  } else if (action === "codex_maintenance") {
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_report") {
    await editOrReplyHtml(ctx, formatCodexMaintenanceReportHtml(await readCodexMaintenanceReport()), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_backup") {
    await editOrReplyHtml(ctx, `${b(t("busyBackup"))}\n${t("busyBackupDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("backup")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_config") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyConfig"))}\n${t("busyConfigDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("config-prune")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_worktrees") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyWorktrees"))}\n${t("busyWorktreesDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("worktree-archive")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_logs") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyLogs"))}\n${t("busyLogsDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("log-rotate")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_sqlite_repair") {
    await editOrReplyHtml(ctx, codexMaintenanceSqliteRepairConfirmHtml(), inlineKeyboard([
      [
        { text: t("repairRun"), callback_data: "tool:codex_maintenance_sqlite_repair_apply", style: "danger" },
        { text: t("cancel"), callback_data: "tool:codex_maintenance", style: "primary" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "tool:codex_maintenance" }]
    ]));
  } else if (action === "codex_maintenance_sqlite_repair_apply") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyRepair"))}\n${t("busyRepairDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatCodexMaintenanceResultHtml(await runCodexMaintenance("sqlite-metadata-repair")), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_handoff") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    await editOrReplyHtml(ctx, `${b(t("busyHandoff"))}\n${t("busyHandoffDetail")}`, codexMaintenanceBusyKeyboard());
    await editOrReplyHtml(ctx, formatHandoffResultHtml(await createCurrentThreadHandoff(chatKey)), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_auto_handoff") {
    state.maintenance.autoHandoffEnabled = !maintenanceAutoHandoffEnabled();
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "codex_maintenance_auto_sqlite_repair") {
    state.maintenance.autoSqliteRepairEnabled = !maintenanceAutoSqliteRepairEnabled();
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, codexMaintenanceMenuHtml(), codexMaintenanceKeyboard());
  } else if (action === "forget") {
    await editOrReplyHtml(ctx, `${b(t("forgetConfirmTitle"))}\n${t("forgetConfirmBody")}`, inlineKeyboard([
      [
        { text: t("forgetRun"), callback_data: "confirm:forget" },
        { text: t("cancel"), callback_data: "p:tools" }
      ],
      [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
    ]));
  }
}

function withToolsBack() {
  return inlineKeyboard([
    [{ text: t("tools"), callback_data: "p:tools" }, { text: t("main"), callback_data: "p:main" }],
    [{ text: `← ${t("back")}`, callback_data: "p:tools" }]
  ]);
}

function codexMaintenanceMenuHtml() {
  return [
    b(t("codexMaintenance")),
    "",
    t("maintenanceIntro"),
    t("maintenanceScope"),
    `${t("autoSqliteRepair")}: ${code(maintenanceAutoSqliteRepairEnabled() ? "on" : "off")}`,
    `${t("autoHandoff")}: ${code(maintenanceAutoHandoffEnabled() ? "on" : "off")}`,
    "",
    `- Report: ${t("maintenanceReportDesc")}`,
    `- Backup: ${t("maintenanceBackupDesc")}`,
    `- Config prune: ${t("maintenanceConfigDesc")}`,
    `- Worktrees: ${t("maintenanceWorktreesDesc")}`,
    `- Logs: ${t("maintenanceLogsDesc")}`,
    `- SQLite repair: ${t("maintenanceRepairDesc")}`,
    `- Handoff: ${t("maintenanceHandoffDesc")}`
  ].join("\n");
}

function codexMaintenanceKeyboard() {
  return inlineKeyboard([
    [
      { text: "📊 Report", callback_data: "tool:codex_maintenance_report", style: "primary" },
      { text: "💾 Backup", callback_data: "tool:codex_maintenance_backup", style: "success" }
    ],
    [
      { text: "🧹 Config prune", callback_data: "tool:codex_maintenance_config", style: "primary" },
      { text: "📦 Worktrees archive", callback_data: "tool:codex_maintenance_worktrees", style: "primary" }
    ],
    [
      { text: "🗄️ Logs rotate", callback_data: "tool:codex_maintenance_logs", style: "primary" }
    ],
    [
      { text: "🧬 SQLite repair", callback_data: "tool:codex_maintenance_sqlite_repair", style: "danger" },
      { text: t("handoffCreate"), callback_data: "tool:codex_maintenance_handoff", style: "success" }
    ],
    [
      { text: `🤖 Auto handoff ${maintenanceAutoHandoffEnabled() ? "on" : "off"}`, callback_data: "tool:codex_maintenance_auto_handoff", style: maintenanceAutoHandoffEnabled() ? "success" : "primary" },
      { text: `🤖 Auto repair ${maintenanceAutoSqliteRepairEnabled() ? "on" : "off"}`, callback_data: "tool:codex_maintenance_auto_sqlite_repair", style: maintenanceAutoSqliteRepairEnabled() ? "danger" : "primary" }
    ],
    [
      { text: t("tools"), callback_data: "p:tools" },
      { text: t("main"), callback_data: "p:main" }
    ],
    [
      { text: `← ${t("back")}`, callback_data: "p:tools" }
    ]
  ]);
}

function codexMaintenanceSqliteRepairConfirmHtml() {
  return [
    b(t("sqliteConfirmTitle")),
    "",
    t("sqliteConfirmBody"),
    `title limit: ${code(config.codexMaintenanceThreadTitleLimit)}`,
    `preview limit: ${code(config.codexMaintenanceThreadPreviewLimit)}`,
    "",
    `- ${t("sqliteNoTranscript")}`,
    `- ${t("sqliteRestore")}`,
    `- ${t("sqliteAutoOff")}`,
    "",
    t("sqliteContinue")
  ].join("\n");
}

function codexMaintenanceBusyKeyboard() {
  return inlineKeyboard([[{ text: t("processing"), callback_data: "tool:codex_maintenance", style: "primary" }]]);
}

function maintenanceAutoSqliteRepairEnabled() {
  return state.maintenance?.autoSqliteRepairEnabled === true;
}

function maintenanceAutoHandoffEnabled() {
  return state.maintenance?.autoHandoffEnabled === true;
}

async function readCodexMaintenanceReport() {
  return runCodexMaintenance("report");
}

async function runCodexMaintenance(action) {
  const args = [
    config.codexMaintenanceScript,
    action,
    "--codex-home",
    config.codexHome,
    "--worktree-older-than-days",
    String(config.codexMaintenanceWorktreeDays),
    "--rotate-logs-above-mb",
    String(config.codexMaintenanceLogRotateMb),
    "--thread-title-limit",
    String(config.codexMaintenanceThreadTitleLimit),
    "--thread-preview-limit",
    String(config.codexMaintenanceThreadPreviewLimit)
  ];
  if (action !== "report") {
    args.push("--backup-root", path.join(config.codexMaintenanceBackupDir, `${getLocalDateKey()}-${action}-${Date.now()}`));
  }
  const { stdout } = await execFileAsync("python3", args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function formatCodexMaintenanceReportHtml(report) {
  const sessions = report.sessions || {};
  const archived = report.archivedSessions || {};
  const worktrees = report.worktrees || {};
  const stale = report.staleWorktrees || {};
  const logs = report.logs || {};
  const configPrune = report.configPrune || {};
  const metadata = report.metadataBloat || {};
  const nodeRows = Array.isArray(report.topNodeProcesses) ? report.topNodeProcesses : [];
  const lines = [
    b(t("maintenanceReportTitle")),
    "",
    `codexHome: ${code(report.codexHome || config.codexHome)}`,
    `sessions: ${code(`${sessions.files ?? 0}개`)} / ${code(formatBytes(sessions.bytes ?? 0))}`,
    `archived sessions: ${code(`${archived.files ?? 0}개`)} / ${code(formatBytes(archived.bytes ?? 0))}`,
    `worktrees: ${code(`${worktrees.count ?? 0}개`)} / ${code(formatBytes(worktrees.bytes ?? 0))}`,
    `stale worktrees: ${code(`${stale.candidates ?? 0}개`)} / ${code(formatBytes(stale.bytes ?? 0))}`,
    `logs: ${code(formatBytes(logs.bytes ?? 0))} / rotate ${code(`${logs.rotateThresholdMb ?? config.codexMaintenanceLogRotateMb}MB`)}`,
    `${uiLanguage() === "ko" ? "config prune 후보" : "config prune candidates"}: ${code(`${configPrune.candidates ?? 0}${uiLanguage() === "ko" ? "개" : ""}`)}`,
    `metadata bloat: title ${code(metadata.titlesOverLimit ?? 0)} / preview ${code(metadata.previewsOverLimit ?? 0)} / 10k+ ${code(metadata.previewsOver10k ?? 0)}`
  ];
  if (nodeRows.length > 0) {
    lines.push("", b(t("nodeTop")));
    for (const item of nodeRows.slice(0, 3)) {
      lines.push(`- pid ${code(item.pid)} / ${code(`${item.mb}MB`)}`);
    }
  }
  return lines.join("\n");
}

function formatCodexMaintenanceResultHtml(result) {
  const lines = [
    b(`${t("maintenanceDone")}: ${result.action || "unknown"}`),
    "",
    `backupRoot: ${code(result.backupRoot || "none")}`,
    `backedUp: ${code(`${Array.isArray(result.backedUp) ? result.backedUp.length : 0}개`)}`
  ];
  if (result.configPrune) {
    lines.push(`config prune: 후보 ${code(result.configPrune.candidates)} / applied ${code(result.configPrune.applied)}`);
  }
  if (result.worktreeArchive) {
    lines.push(`worktrees: 후보 ${code(result.worktreeArchive.candidates)} / moved ${code(result.worktreeArchive.moved)} / ${code(formatBytes(result.worktreeArchive.bytes || 0))}`);
    lines.push(`manifest: ${code(result.worktreeArchive.manifest || "none")}`);
  }
  if (result.logRotate) {
    lines.push(`logs: files ${code(result.logRotate.files)} / rotated ${code(result.logRotate.rotated)} / ${code(formatBytes(result.logRotate.bytes || 0))}`);
    if (result.logRotate.skipped) lines.push(`skipped: ${code(result.logRotate.skipped)}`);
    if (result.logRotate.manifest) lines.push(`manifest: ${code(result.logRotate.manifest)}`);
  }
  if (result.sqliteMetadataRepair) {
    const repair = result.sqliteMetadataRepair;
    lines.push(`sqlite repair: 후보 ${code(repair.candidates ?? 0)} / repaired ${code(repair.repaired ?? 0)}`);
    lines.push(`limits: title ${code(repair.titleLimit ?? config.codexMaintenanceThreadTitleLimit)} / preview ${code(repair.previewLimit ?? config.codexMaintenanceThreadPreviewLimit)}`);
    if (repair.manifest) lines.push(`manifest: ${code(repair.manifest)}`);
    if (repair.restoreScript) lines.push(`restore: ${code(repair.restoreScript)}`);
    if (repair.reason) lines.push(`reason: ${code(repair.reason)}`);
  }
  return lines.join("\n");
}

async function createCurrentThreadHandoff(chatKey) {
  const chat = getChatState(chatKey);
  const cached = threadCache.get(chatKey);
  const fallbackSession = chat.threadId || cached?.id ? null : (await listRecentCodexSessions(1))[0] ?? null;
  const threadId = chat.threadId || cached?.id || fallbackSession?.id || "";
  if (!threadId) {
    throw new Error("handoff를 만들 Codex thread가 없습니다. 먼저 /resume 또는 /new로 thread를 연결하세요.");
  }
  return createThreadHandoff(threadId);
}

async function createThreadHandoff(threadId) {
  const sessionFile = await findCodexSessionFile(threadId);
  if (!sessionFile) {
    throw new Error(`session 파일을 찾을 수 없습니다: ${threadId}`);
  }
  const meta = await readSessionMeta(sessionFile);
  const highlights = await readSessionHighlights(sessionFile, config.codexHandoffRecentEvents);
  const targetDir = await resolveHandoffDir(meta?.cwd);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, `${getLocalDateKey()}-${sanitizeFilename((meta?.cwd || "codex").split(path.sep).filter(Boolean).pop() || "codex")}-${threadId.slice(0, 8)}.md`);
  const body = renderHandoffMarkdown({
    threadId,
    sessionFile,
    meta,
    highlights,
    generatedAt: new Date().toISOString()
  });
  await fs.writeFile(file, body, "utf8");
  return { ok: true, file, threadId, cwd: meta?.cwd || "", highlights: highlights.length };
}

async function resolveHandoffDir(cwd) {
  const configured = config.codexHandoffDir;
  if (cwd && path.isAbsolute(cwd)) {
    try {
      const stat = await fs.stat(cwd);
      if (stat.isDirectory()) return path.join(cwd, "docs", "codex-handoffs");
    } catch {
      // Fall through to configured handoff dir.
    }
  }
  return configured;
}

async function readSessionHighlights(file, limit) {
  const highlights = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const highlight = sessionHighlightFromItem(item);
    if (!highlight) continue;
    highlights.push(highlight);
    while (highlights.length > limit) highlights.shift();
  }
  return highlights;
}

function sessionHighlightFromItem(item) {
  const timestamp = item?.timestamp || "";
  const payload = item?.payload || {};
  if (item?.type === "event_msg" && payload.type === "agent_message") {
    return { timestamp, kind: "assistant-comment", text: payload.message || "" };
  }
  if (item?.type !== "response_item") return null;
  if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
    const text = extractContentText(payload.content);
    if (!text) return null;
    return { timestamp, kind: payload.role, text };
  }
  if (payload.type === "function_call") {
    return { timestamp, kind: "tool-call", text: `${payload.name || "tool"} ${truncate((payload.arguments || "").replace(/\s+/g, " "), 220)}` };
  }
  if (payload.type === "function_call_output") {
    return { timestamp, kind: "tool-output", text: truncate(String(payload.output || "").replace(/\s+/g, " "), 260) };
  }
  return null;
}

function extractContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => entry?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function renderHandoffMarkdown({ threadId, sessionFile, meta, highlights, generatedAt }) {
  const title = `Codex Handoff ${threadId.slice(0, 8)}`;
  const lines = [
    `# ${title}`,
    "",
    "## Reactivation Prompt",
    "",
    "We are continuing from this handoff. Read this document first, inspect the current repo state, verify what still applies, and continue from the next steps without assuming the old chat context is available.",
    "",
    "## Session",
    "",
    `- thread_id: \`${threadId}\``,
    `- generated_at: \`${generatedAt}\``,
    `- cwd: \`${meta?.cwd || "unknown"}\``,
    `- source: \`${meta?.source || "unknown"}\``,
    `- originator: \`${meta?.originator || "unknown"}\``,
    `- session_file: \`${sessionFile}\``,
    "",
    "## Current State",
    "",
    "- This is an automatic handoff draft generated from local Codex session metadata.",
    "- Review the current git status and project instructions before continuing.",
    "- Treat the recent highlights below as a navigation aid, not as a complete transcript.",
    "",
    "## Recent Highlights",
    ""
  ];
  if (highlights.length === 0) {
    lines.push("- No readable recent highlights were found.");
  } else {
    for (const item of highlights) {
      lines.push(`- ${item.timestamp ? `\`${item.timestamp}\` ` : ""}${item.kind}: ${truncateMarkdownLine(item.text, 320)}`);
    }
  }
  lines.push(
    "",
    "## Next Steps",
    "",
    "1. Read project-local `AGENTS.md` or equivalent instructions.",
    "2. Check `git status --short --branch` in the repo.",
    "3. Re-open the files mentioned in the recent highlights.",
    "4. Continue from the latest user request, keeping changes scoped and verified.",
    ""
  );
  return `${lines.join("\n")}`;
}

function formatHandoffResultHtml(result) {
  return formatKeyValueHtml("🧾 Active thread handoff 생성 완료", [
    ["thread", result.threadId],
    ["file", result.file],
    ["cwd", result.cwd || "unknown"],
    ["highlights", `${result.highlights}개`]
  ]);
}

function sanitizeFilename(value) {
  return String(value || "codex")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "codex";
}

function truncateMarkdownLine(value, max) {
  return truncate(String(value || "").replace(/\s+/g, " ").replaceAll("`", "'"), max);
}

function formatConfigHtml() {
  return formatKeyValueHtml("SDK constructor options:", [
    ["codexPathOverride", config.codexPath],
    ["baseUrl", config.codexBaseUrl || "default"],
    ["apiKey", config.codexApiKey ? "set" : "default auth"],
    ["config", config.codexConfig ? "set" : "none"],
    ["env", config.codexEnv ? "set" : "inherit process.env"],
    ["modelsCacheFile", config.codexModelsCacheFile]
  ]);
}

async function handleConfirmButton(ctx, action) {
  const chatKey = getChatKey(ctx);
  if (action === "q_clear") {
    const cleared = await clearPendingTurns(chatKey);
    await editOrReplyHtml(ctx, `${b(t("clearQueueDone"))}\nCleared queued turns: ${code(cleared)}`, queueKeyboard(chatKey));
    return;
  }
  if (action === "forget") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    threadCache.delete(chatKey);
    delete state.chats[chatKey];
    delete state.queues[chatKey];
    pendingTurns.delete(chatKey);
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, uiLanguage() === "ko" ? "Codex thread와 채팅별 설정을 지웠습니다." : "Forgot the Codex thread and chat-specific options.", backToMainKeyboard());
    return;
  }
  if (action === "prefs_reset") {
    if (await rejectCallbackIfActive(ctx, chatKey)) return;
    const chat = getChatState(chatKey);
    chat.options = {};
    delete chat.outputSchema;
    invalidateThreadCache(chatKey);
    await saveState(config.stateFile, state);
    await editOrReplyHtml(ctx, `${b(uiLanguage() === "ko" ? "Preferences 초기화 완료" : "Preferences reset.")}\n\n${settingsPanelHtml(chatKey)}`, settingsKeyboard());
  }
}

async function rejectCallbackIfActive(ctx, chatKey) {
  if (!activeTurns.has(chatKey)) return false;
  await editOrReplyHtml(ctx, `Codex turn is already running. Use ${code("/stop")} first. Plain messages can still be queued.`, statusKeyboard(chatKey));
  return true;
}

async function listCodexModels() {
  try {
    const parsed = JSON.parse(await fs.readFile(config.codexModelsCacheFile, "utf8"));
    const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
    const models = rawModels
      .filter((model) => model?.slug && (model.visibility === "list" || model.supported_in_api !== false))
      .sort((left, right) => (left.priority ?? 999) - (right.priority ?? 999))
      .map((model) => ({
        slug: model.slug,
        displayName: model.display_name || model.slug,
        fastSupported: hasFastServiceTier(model),
        defaultReasoning: model.default_reasoning_level || "",
        supportedReasoning: Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []
      }));
    return models.length > 0 ? uniqueModels(models).slice(0, 12) : FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}

function hasFastServiceTier(model) {
  if (Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes("fast")) return true;
  if (Array.isArray(model.service_tiers)) {
    return model.service_tiers.some((tier) => {
      const id = String(tier?.id ?? tier?.name ?? tier).toLowerCase();
      return id === "fast";
    });
  }
  return false;
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.slug)) return false;
    seen.add(model.slug);
    return true;
  });
}

function modelSelectionKeyboard(models) {
  const buttons = models.map((model) => ({
    text: `${model.displayName}${model.fastSupported ? " ⚡" : ""}`,
    callback_data: `model:set:${model.slug}`
  }));
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(buttons, 2),
        [{ text: "Default", callback_data: "model:set:default" }]
      ]
    }
  };
}

function reasoningSelectionKeyboard() {
  const buttons = [
    { text: "Default", callback_data: "reasoning:set:default" },
    ...[...VALID.reasoning].map((value) => ({ text: value, callback_data: `reasoning:set:${value}` }))
  ];
  return {
    reply_markup: {
      inline_keyboard: chunk(buttons, 3)
    }
  };
}

function formatModelSelectionHtml(chatKey, models) {
  const options = getEffectiveOptions(chatKey);
  const fastModels = models.filter((model) => model.fastSupported).map((model) => model.slug);
  return [
    b(uiLanguage() === "ko" ? "Model 선택" : "Model Selection"),
    `Current model: ${code(options.model || "default")}`,
    `Current thinking: ${code(options.modelReasoningEffort)}`,
    `Fast service tier: ${code(options.serviceTier || "default")}`,
    "",
    uiLanguage() === "ko" ? "모델을 선택하면 thinking 설정 버튼이 이어서 표시됩니다." : "Choose a model; thinking buttons will be shown next.",
    `⚡ Fast 지원: ${code(fastModels.length > 0 ? fastModels.join(", ") : "unknown")}`
  ].join("\n");
}

function formatReasoningPromptHtml(chatKey) {
  const options = getEffectiveOptions(chatKey);
  return [
    b(uiLanguage() === "ko" ? "Thinking 설정" : "Thinking Settings"),
    `Model: ${code(options.model || "default")}`,
    `Current thinking: ${code(options.modelReasoningEffort)}`,
    "",
    uiLanguage() === "ko" ? "사용할 thinking level을 선택하세요." : "Choose the thinking level to use."
  ].join("\n");
}

function formatFastStatusHtml(chatKey, models) {
  const options = getEffectiveOptions(chatKey);
  const fastModels = models.filter((model) => model.fastSupported).map((model) => model.slug);
  return formatKeyValueHtml("Fast service tier:", [
    ["fast", options.serviceTier === "fast" ? "on" : "off"],
    ["service_tier", options.serviceTier || "default"],
    ["current model", options.model || "default"],
    ["fast-supported models", fastModels.length > 0 ? fastModels.join(", ") : "unknown"]
  ]);
}

function formatOptionsHtml(chatKey) {
  const options = getEffectiveOptions(chatKey);
  return formatKeyValueHtml("Options:", [
    ["model", options.model || "default"],
    ["workingDirectory", options.workingDirectory],
    ["sandboxMode", options.sandboxMode],
    ["approvalPolicy", options.approvalPolicy],
    ["skipGitRepoCheck", options.skipGitRepoCheck],
    ["modelReasoningEffort", options.modelReasoningEffort],
    ["serviceTier", options.serviceTier || "default"],
    ["webSearchMode", options.webSearchMode],
    ["networkAccessEnabled", formatOptional(options.networkAccessEnabled)],
    ["additionalDirectories", (options.additionalDirectories ?? []).join(", ") || "none"],
    ["streamEvents", options.streamEvents],
    ["liveProgressEnabled", options.liveProgressEnabled],
    ["liveProgressSource", options.liveProgressSource],
    ["liveProgressDeletePolicy", options.liveProgressDeletePolicy],
    ["language", uiLanguage()],
    ["timeZone", uiTimeZone()],
    ["locale", uiLocale()],
    ["outputSchema", getChatState(chatKey).outputSchema ? "enabled" : "disabled"]
  ]);
}

async function buildStatusDetails(chatKey) {
  const chat = getChatState(chatKey);
  const cached = threadCache.get(chatKey);
  const activeInfo = activeTurns.get(chatKey) ?? null;
  const threadId = chat.threadId || cached?.id || "";
  const fallbackSession = threadId ? null : (await listRecentCodexSessions(1))[0] ?? null;
  const usageSummary = await buildCodexUsageSummary(threadId || fallbackSession?.id || "");
  return {
    threadId,
    active: Boolean(activeInfo),
    activeInfo,
    sideTurns: getSideTurnCount(chatKey),
    queued: getPendingTurns(chatKey).length,
    queuePaused: isQueuePaused(chatKey),
    queueMode: getQueueMode(chatKey),
    fallbackSession,
    usageSummary
  };
}

function formatStatusHtml(chatKey, details) {
  const lines = [
    b("Codex Telegram Bot"),
    `Thread: ${code(details.threadId || "not started")}`,
    `Active turn: ${code(details.active ? "yes" : "no")}`,
    `Side turns: ${code(details.sideTurns ?? getSideTurnCount(chatKey))}`,
    `Queue mode: ${code(details.queueMode ?? getQueueMode(chatKey))}`,
    `Queue paused: ${code(details.queuePaused ? "yes" : "no")}`,
    `Queued turns: ${code(details.queued ?? getPendingTurns(chatKey).length)}`
  ];
  if (details.activeInfo?.currentTurnStartedAt) {
    const elapsed = Math.max(0, (Date.now() - Date.parse(details.activeInfo.currentTurnStartedAt)) / 1000);
    lines.push(
      `Current turn: ${code(truncate(details.activeInfo.currentText?.replace(/\s+/g, " ") || "unknown", 100))}`,
      `Elapsed: ${code(formatDurationSeconds(elapsed))}`
    );
    if (details.activeInfo.lastProgress) {
      lines.push(
        `Last progress: ${code(truncate(details.activeInfo.lastProgress, 100))}`,
        `Last progress at: ${code(formatDateTime(details.activeInfo.lastProgressAt))}`
      );
    }
  }
  if (details.fallbackSession) lines.push(`Usage source: latest session ${code(details.fallbackSession.id)}`);
  if (details.usageSummary) lines.push("", pre(details.usageSummary));
  lines.push("", formatOptionsHtml(chatKey));
  return lines.join("\n");
}

function formatQueueHtml(chatKey) {
  const queue = getPendingTurns(chatKey);
  if (queue.length === 0) {
    return [
      b("Codex queue"),
      `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
      `Side turns: ${code(getSideTurnCount(chatKey))}`,
      `Mode: ${code(getQueueMode(chatKey))}`,
      `Paused: ${code(isQueuePaused(chatKey) ? "yes" : "no")}`,
      t("queueNoTurns")
    ].join("\n");
  }

  const lines = [
    b("Codex queue"),
    `Active turn: ${code(activeTurns.has(chatKey) ? "yes" : "no")}`,
    `Side turns: ${code(getSideTurnCount(chatKey))}`,
    `Mode: ${code(getQueueMode(chatKey))}`,
    `Paused: ${code(isQueuePaused(chatKey) ? "yes" : "no")}`,
    `Queued turns: ${code(queue.length)} / ${code(runtimeValue("telegramPendingTurnsMax"))}`,
    `Auto expiry: ${code(runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds")))}`,
    ""
  ];
  for (const [index, turn] of queue.entries()) {
    const imageSuffix = turn.imagePaths.length > 0 ? `, images:${turn.imagePaths.length}` : "";
    const expires = runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "no expiry" : `expires ${formatDateTime(turn.expiresAt)}`;
    lines.push(`${index + 1}. ${code(truncate(turn.text.replace(/\s+/g, " "), 120))} (${code(turn.id)}, ${code(formatDateTime(turn.enqueuedAt))}, ${code(expires)}${imageSuffix})`);
  }
  lines.push("", t("queueButtonsHelp"));
  return lines.join("\n");
}

function formatQueueModeHtml(chatKey) {
  return [
    b("Codex queue mode"),
    `Current: ${code(getQueueMode(chatKey))}`,
    "",
    `${code("safe")}: ${uiLanguage() === "ko" ? "실행 중 새 메시지를 queue에 저장하고 순차 실행합니다." : "Queue new messages while a turn is running and process them in order."}`,
    `${code("interrupt")}: ${uiLanguage() === "ko" ? "실행 중 새 메시지가 오면 현재 turn을 중단하고 새 메시지를 다음 turn으로 바로 실행합니다." : "Interrupt the current turn and run the new message next."}`,
    `${code("side")}: ${uiLanguage() === "ko" ? "현재 turn은 유지하고 새 메시지는 별도 side thread에서 답합니다." : "Keep the current turn running and answer the new message in a side thread."}`,
    "",
    `Change with ${code("/queue_mode_safe")}, ${code("/queue_mode_interrupt")}, or ${code("/queue_mode_side")}.`
  ].join("\n");
}

function queueKeyboard(chatKey) {
  const paused = isQueuePaused(chatKey);
  const rows = [
    [
      { text: paused ? t("resumeAuto") : t("pauseAuto"), callback_data: paused ? "q:resume" : "q:pause" },
      { text: t("refresh"), callback_data: "p:queue" }
    ],
    [
      { text: "safe", callback_data: "q:mode:safe" },
      { text: "interrupt", callback_data: "q:mode:interrupt" },
      { text: "side", callback_data: "q:mode:side" }
    ]
  ];
  if (getPendingTurns(chatKey).length > 0) {
    rows.push([{ text: t("clearAll"), callback_data: "q:clear" }]);
  }
  for (const [index, turn] of getPendingTurns(chatKey).slice(0, 10).entries()) {
    const label = `#${index + 1}`;
    rows.push([
      { text: `${label} ${t("cancelItem")}`, callback_data: `queue:cancel:${turn.id}` },
      { text: `${label} ↑`, callback_data: `queue:up:${turn.id}` },
      { text: `${label} next`, callback_data: `queue:next:${turn.id}` }
    ]);
  }
  rows.push([{ text: t("main"), callback_data: "p:main" }]);
  rows.push([{ text: `← ${t("back")}`, callback_data: "p:main" }]);
  return inlineKeyboard(rows);
}

async function formatDoctorHtml(chatKey) {
  const [botPackage, sdkPackage, cliVersion, modelsMeta, yoloWrapper] = await Promise.all([
    readJsonFile(path.join(appRoot, "package.json")),
    readPackageJson("@openai/codex-sdk"),
    readCommandOutput(config.codexPath, ["--version"], 5000),
    readModelsCacheMeta(),
    readYoloWrapperStatus()
  ]);
  const options = getEffectiveOptions(chatKey);
  const declaredSdk = botPackage?.dependencies?.["@openai/codex-sdk"] || "unknown";
  const rows = [
    ["bot version", botPackage?.version || "unknown"],
    ["node", process.version],
    ["codex-sdk installed", sdkPackage?.version || "unknown"],
    ["codex-sdk declared", declaredSdk],
    ["codex cli", cliVersion.ok ? cliVersion.output : `error: ${cliVersion.error}`],
    ["codex path", config.codexPath],
    ["yolo wrapper", yoloWrapper],
    ["models cache", modelsMeta.status],
    ["models cache client", modelsMeta.clientVersion],
    ["models cache fetched", modelsMeta.fetchedAt],
    ["fast models", modelsMeta.fastModels],
    ["current model", options.model || "default"],
    ["current thinking", options.modelReasoningEffort],
    ["current serviceTier", options.serviceTier || "default"],
    ["upgrade smoke test", "/status -> /model -> /fast_status -> message -> /new -> /resume_last"]
  ];
  return formatKeyValueHtml("Codex doctor:", rows);
}

async function formatHealthHtml() {
  const memory = process.memoryUsage();
  const [stateCheck, backupCheck, workdirDisk, stateDisk, serviceStatus] = await Promise.all([
    checkStateReadWrite(),
    checkDirectoryWritable(config.backupDir),
    getDiskSummary(config.codexWorkdir),
    getDiskSummary(path.dirname(config.stateFile)),
    readCommandOutput("systemctl", ["--user", "is-active", "codex-telegram-bot.service"], 3000)
  ]);
  return formatKeyValueHtml("Bot health:", [
    ["service", serviceStatus.ok ? serviceStatus.output : "unknown"],
    ["uptime", formatDurationSeconds(process.uptime())],
    ["memory rss", formatBytes(memory.rss)],
    ["memory heap", `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`],
    ["active turns", activeTurns.size],
    ["side turns", countSideTurns()],
    ["cached threads", threadCache.size],
    ["saved chats", Object.keys(state.chats).length],
    ["live progress", runtimeValue("telegramLiveProgressEnabled") ? `${runtimeValue("telegramLiveProgressMode")}, ${config.telegramLiveProgressSource}, ${config.telegramLiveProgressDeletePolicy}, ${Math.round(runtimeValue("telegramLiveProgressIntervalMs") / 1000)}s interval` : "off"],
    ["queue expiry", runtimeValue("telegramPendingTurnMaxAgeSeconds") <= 0 ? "off" : formatDurationSeconds(runtimeValue("telegramPendingTurnMaxAgeSeconds"))],
    ["state read/write", stateCheck],
    ["backup dir write", backupCheck],
    ["workdir disk", workdirDisk],
    ["state disk", stateDisk],
    ["pending turns", countPendingTurns()],
    ["backup dir", config.backupDir],
    ["time zone", uiTimeZone()],
    ["locale", uiLocale()],
    ["snapshots", runtimeValue("snapshotEnabled") ? `on, ${runtimeValue("snapshotNotifyTime")} ${uiTimeZone()}, ${runtimeValue("snapshotRetentionDays")}d retention` : "off"]
  ]);
}

function formatPrefsHtml(chatKey) {
  const chat = getChatState(chatKey);
  const options = getEffectiveOptions(chatKey);
  return formatKeyValueHtml("Chat preferences:", [
    ["thread", chat.threadId || threadCache.get(chatKey)?.id || "not started"],
    ["model", options.model || "default"],
    ["thinking", options.modelReasoningEffort],
    ["fast", options.serviceTier === "fast" ? "on" : "off"],
    ["queue mode", getQueueMode(chatKey)],
    ["workdir", options.workingDirectory],
    ["sandbox", options.sandboxMode],
    ["approval", options.approvalPolicy],
    ["websearch", options.webSearchMode],
    ["network", formatOptional(options.networkAccessEnabled)],
    ["stream", options.streamEvents],
    ["live progress", options.liveProgressEnabled ? `${options.liveProgressSource}, ${options.liveProgressDeletePolicy}` : "off"],
    ["schema", chat.outputSchema ? "enabled" : "disabled"],
    ["additional dirs", (options.additionalDirectories ?? []).join(", ") || "none"],
    ["reset", "/prefs_reset"]
  ]);
}

function formatWhoamiHtml(ctx) {
  const userId = String(ctx.from?.id ?? "");
  return formatKeyValueHtml("Telegram identity:", [
    ["allowed", config.allowedUserIds.has(userId) ? "yes" : "no"],
    ["user id", userId || "unknown"],
    ["chat id", String(ctx.chat?.id ?? "unknown")],
    ["chat type", ctx.chat?.type || "unknown"],
    ["username", ctx.from?.username ? `@${ctx.from.username}` : "none"],
    ["name", [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "unknown"],
    ["language", ctx.from?.language_code || "unknown"]
  ]);
}

async function formatLogsHtml(ctx, overrideArg = null) {
  const arg = (overrideArg ?? getCommandArgs(ctx).trim()).toLowerCase();
  let lines = 40;
  let priorityArgs = [];
  if (arg === "error" || arg === "errors") {
    priorityArgs = ["-p", "warning"];
  } else if (arg) {
    const parsed = Number(arg);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return `Usage: ${code("/logs [lines]")} or ${code("/logs_error")}`;
    }
    lines = Math.min(parsed, runtimeValue("logsMaxLines"));
  }
  const result = await readCommandOutput(
    "journalctl",
    ["--user", "-u", "codex-telegram-bot.service", ...priorityArgs, "-n", String(lines), "--no-pager"],
    5000
  );
  if (!result.ok) return `${b("Logs unavailable")}\n${code(result.error)}`;
  let body = redactText(result.output).split("\n").slice(-runtimeValue("logsMaxLines")).join("\n");
  const maxBodyLength = Math.max(500, runtimeValue("maxTelegramChars") - 300);
  if (body.length > maxBodyLength) body = `... truncated ...\n${body.slice(-maxBodyLength)}`;
  return `${b("Recent bot logs:")}\n${pre(body || "no logs")}`;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readPackageJson(packageName) {
  return readJsonFile(path.join(appRoot, "node_modules", ...packageName.split("/"), "package.json"));
}

async function readCommandOutput(command, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024, timeout: timeoutMs });
    return { ok: true, output: (stdout || stderr).trim() || "no output" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readModelsCacheMeta() {
  try {
    const stat = await fs.stat(config.codexModelsCacheFile);
    const parsed = JSON.parse(await fs.readFile(config.codexModelsCacheFile, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const fastModels = models
      .filter((model) => model?.slug && hasFastServiceTier(model))
      .map((model) => model.slug);
    return {
      status: `found, ${models.length} models, ${formatBytes(stat.size)}`,
      clientVersion: parsed?.client_version || "unknown",
      fetchedAt: parsed?.fetched_at || "unknown",
      fastModels: fastModels.length > 0 ? fastModels.join(", ") : "unknown"
    };
  } catch (error) {
    return {
      status: `missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      clientVersion: "unknown",
      fetchedAt: "unknown",
      fastModels: "unknown"
    };
  }
}

async function readYoloWrapperStatus() {
  try {
    const body = await fs.readFile(config.codexPath, "utf8");
    if (body.includes("--dangerously-bypass-approvals-and-sandbox")) return "enabled";
    return "not detected";
  } catch {
    return "not inspected";
  }
}

async function checkStateReadWrite() {
  try {
    await fs.readFile(config.stateFile, "utf8");
    await checkDirectoryWritable(path.dirname(config.stateFile));
    return "ok";
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function checkDirectoryWritable(dir) {
  const testFile = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(testFile, "ok\n", "utf8");
    await fs.rm(testFile, { force: true });
    return "ok";
  } catch (error) {
    await fs.rm(testFile, { force: true }).catch(() => {});
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function getDiskSummary(targetPath) {
  const result = await readCommandOutput("df", ["-Pk", targetPath], 3000);
  if (!result.ok) return `unknown: ${result.error}`;
  const line = result.output.split("\n").at(-1);
  const parts = line?.trim().split(/\s+/) ?? [];
  if (parts.length < 6) return "unknown";
  const available = Number(parts[3]) * 1024;
  const usedPercent = parts[4];
  return `${formatBytes(available)} free, ${usedPercent} used`;
}

function formatKeyValueHtml(title, rows) {
  return [
    b(title),
    ...rows.map(([key, value]) => `${escapeHtml(key)}: ${code(String(value))}`)
  ].join("\n");
}

async function registerTelegramCommands() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const commands = telegramCommands(uiLanguage());
      await withTimeout(Promise.all([
        bot.telegram.setMyCommands(commands),
        ...TELEGRAM_LANGUAGE_CODES.map((languageCode) => bot.telegram.setMyCommands(commands, { language_code: languageCode }))
      ]), 5000, "setMyCommands timed out");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Telegram command menu registration failed (${attempt}/3):`, message);
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }
}

function telegramCommands(language = uiLanguage()) {
  const text = (key) => textFor(language, key);
  return [
    { command: "menu", description: text("commandMenu") },
    { command: "new", description: text("commandNew") },
    { command: "resume", description: text("commandResume") },
    { command: "status", description: text("commandStatus") },
    { command: "queue", description: text("commandQueue") },
    { command: "settings", description: text("commandSettings") },
    { command: "tools", description: text("commandTools") },
    { command: "stop", description: text("commandStop") },
    { command: "help", description: text("commandHelp") }
  ];
}

async function replyLong(ctx, text) {
  const max = Math.max(500, runtimeValue("maxTelegramChars"));
  for (const chunk of splitText(text, max)) await ctx.reply(chunk);
}

async function replyCodexAnswer(ctx, text) {
  if (runtimeValue("telegramFormatCodexAnswers") === "off") {
    await replyLong(ctx, text);
    return;
  }

  const max = Math.max(500, runtimeValue("maxTelegramChars"));
  for (const chunk of splitMarkdownAware(text, max)) {
    const html = runtimeValue("telegramFormatCodexAnswers") === "markdown"
      ? formatCodexAnswerMarkdownHtml(chunk)
      : formatCodexAnswerSafeHtml(chunk);
    await replyHtml(ctx, html);
  }
}

async function replyHtml(ctx, html, extra = {}) {
  try {
    return await ctx.reply(html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    console.warn("Telegram HTML reply failed:", error instanceof Error ? error.message : String(error));
    return ctx.reply(stripHtml(html), extra);
  }
}

async function editOrReplyHtml(ctx, html, extra = {}) {
  try {
    return await ctx.editMessageText(html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("message is not modified")) {
      console.warn("Telegram HTML edit failed:", message);
    }
  }
  try {
    return await ctx.editMessageText(stripHtml(html), extra);
  } catch {
    return replyHtml(ctx, html, extra);
  }
}

async function replyTrackedProgressHtml(ctx, progressState, html) {
  const message = await replyHtml(ctx, html);
  trackProgressMessage(ctx, progressState, message);
  return message;
}

function trackProgressMessage(ctx, progressState, message) {
  const chatId = message?.chat?.id ?? ctx.chat?.id;
  const messageId = message?.message_id;
  if (!chatId || !messageId) return;
  progressState.messageRefs.push({ chatId, messageId });
}

async function deleteTrackedProgressMessages(ctx, progressState) {
  const refs = progressState?.messageRefs ?? [];
  progressState.messageRefs = [];
  for (const ref of refs) {
    await ctx.telegram.deleteMessage(ref.chatId, ref.messageId).catch(() => {});
  }
}

async function replyDocumentQuietly(ctx, filePath, caption) {
  try {
    await ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) }, { caption });
  } catch (error) {
    await replyHtml(ctx, `Document upload failed. File remains on disk:\n${code(filePath)}\n${code(error instanceof Error ? error.message : String(error))}`);
  }
}

async function sendHtmlMessage(chatId, html, extra = {}) {
  try {
    return await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    console.warn("Telegram HTML send failed:", error instanceof Error ? error.message : String(error));
    return bot.telegram.sendMessage(chatId, stripHtml(html), extra);
  }
}

function formatCodexAnswerSafeHtml(text) {
  let html = "";
  let index = 0;
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;

  for (const match of text.matchAll(fencePattern)) {
    html += formatInlineCodeSafeHtml(text.slice(index, match.index));
    const language = match[1]?.trim();
    const body = match[2] ?? "";
    const label = language ? `${language}\n` : "";
    html += pre(`${label}${body}`);
    index = match.index + match[0].length;
  }

  html += formatInlineCodeSafeHtml(text.slice(index));
  return html;
}

function formatInlineCodeSafeHtml(text) {
  let html = "";
  let index = 0;
  const inlinePattern = /`([^`\n]{1,200})`/g;

  for (const match of text.matchAll(inlinePattern)) {
    html += escapeHtml(text.slice(index, match.index));
    html += code(match[1]);
    index = match.index + match[0].length;
  }

  html += escapeHtml(text.slice(index));
  return html;
}

function formatCodexAnswerMarkdownHtml(text) {
  const tokens = markdown.parse(text, {});
  return renderMarkdownTokens(tokens).trimEnd() || escapeHtml(text);
}

function renderMarkdownTokens(tokens) {
  let html = "";
  const listStack = [];

  for (const token of tokens) {
    if (token.type === "inline") {
      html += renderInlineTokens(token.children ?? []);
    } else if (token.type === "paragraph_open") {
      if (html && !html.endsWith("\n") && !isAtListMarker(html)) html += "\n";
    } else if (token.type === "paragraph_close") {
      html = trimTrailingSpaces(html);
      html += "\n";
    } else if (token.type === "heading_open") {
      if (html && !html.endsWith("\n")) html += "\n";
      html += "<b>";
    } else if (token.type === "heading_close") {
      html = trimTrailingSpaces(html);
      html += "</b>\n";
    } else if (token.type === "bullet_list_open") {
      listStack.push({ type: "bullet", index: 0 });
      if (html && !html.endsWith("\n")) html += "\n";
    } else if (token.type === "ordered_list_open") {
      listStack.push({ type: "ordered", index: Number(token.attrGet("start") ?? 1) - 1 });
      if (html && !html.endsWith("\n")) html += "\n";
    } else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      listStack.pop();
      html = trimTrailingSpaces(html);
      if (!html.endsWith("\n")) html += "\n";
    } else if (token.type === "list_item_open") {
      const list = listStack.at(-1);
      if (html && !html.endsWith("\n")) html += "\n";
      if (!list || list.type === "bullet") {
        html += "- ";
      } else {
        list.index += 1;
        html += `${list.index}. `;
      }
    } else if (token.type === "list_item_close") {
      html = trimTrailingSpaces(html);
      if (!html.endsWith("\n")) html += "\n";
    } else if (token.type === "fence") {
      if (html && !html.endsWith("\n")) html += "\n";
      const language = token.info?.trim().split(/\s+/, 1)[0] ?? "";
      html += pre(language ? `${language}\n${token.content}` : token.content);
      html += "\n";
    } else if (token.type === "code_block") {
      if (html && !html.endsWith("\n")) html += "\n";
      html += pre(token.content);
      html += "\n";
    } else if (token.type === "blockquote_open") {
      if (html && !html.endsWith("\n")) html += "\n";
      html += "<blockquote>";
    } else if (token.type === "blockquote_close") {
      html = trimTrailingSpaces(html);
      html += "</blockquote>\n";
    } else if (token.type === "hr") {
      if (html && !html.endsWith("\n")) html += "\n";
      html += "-----\n";
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      html += "\n";
    } else if (token.type === "html_block") {
      html += escapeHtml(token.content);
    }
  }

  return collapseExcessBlankLines(html);
}

function renderInlineTokens(tokens) {
  let html = "";
  const linkStack = [];

  for (const token of tokens) {
    if (token.type === "text") {
      html += escapeHtml(token.content);
    } else if (token.type === "code_inline") {
      html += code(token.content);
    } else if (token.type === "strong_open") {
      html += "<b>";
    } else if (token.type === "strong_close") {
      html += "</b>";
    } else if (token.type === "em_open") {
      html += "<i>";
    } else if (token.type === "em_close") {
      html += "</i>";
    } else if (token.type === "s_open") {
      html += "<s>";
    } else if (token.type === "s_close") {
      html += "</s>";
    } else if (token.type === "link_open") {
      const href = token.attrGet("href") ?? "";
      const safe = isSafeTelegramHref(href);
      linkStack.push(safe);
      if (safe) html += `<a href="${escapeHtmlAttribute(href)}">`;
    } else if (token.type === "link_close") {
      if (linkStack.pop()) html += "</a>";
    } else if (token.type === "image") {
      html += escapeHtml(token.content || token.attrGet("alt") || "");
    } else if (token.type === "html_inline") {
      html += escapeHtml(token.content);
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      html += "\n";
    } else if (token.children?.length) {
      html += renderInlineTokens(token.children);
    }
  }

  return html;
}

function isSafeTelegramHref(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function trimTrailingSpaces(value) {
  return value.replace(/[ \t]+$/g, "");
}

function collapseExcessBlankLines(value) {
  return value.replace(/\n{3,}/g, "\n\n");
}

function isAtListMarker(value) {
  return /(?:^|\n)(?:- |\d+\. )$/.test(value);
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let index = remaining.lastIndexOf("\n", max);
    if (index < max * 0.5) index = remaining.lastIndexOf(" ", max);
    if (index < max * 0.5) index = max;
    chunks.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitMarkdownAware(text, max) {
  if (text.length <= max) return [text];

  const chunks = [];
  let current = "";
  let inFence = false;
  const lines = text.split(/(\n)/);

  for (let index = 0; index < lines.length; index += 2) {
    const line = `${lines[index] ?? ""}${lines[index + 1] ?? ""}`;
    const fenceMatchCount = (line.match(/```/g) ?? []).length;

    if (!inFence && current && current.length + line.length > max) {
      chunks.push(current.trimEnd());
      current = "";
    }

    if (line.length > max) {
      if (current) {
        chunks.push(current.trimEnd());
        current = "";
      }
      chunks.push(...splitText(line.trimEnd(), max));
      if (fenceMatchCount % 2 === 1) inFence = !inFence;
      continue;
    }

    current += line;
    if (fenceMatchCount % 2 === 1) inFence = !inFence;

    if (!inFence && current.length >= max) {
      chunks.push(current.trimEnd());
      current = "";
    } else if (inFence && current.length >= max) {
      chunks.push(`${current.trimEnd()}\n\`\`\``);
      current = "```\n";
    }
  }

  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.flatMap((chunk) => splitOversizedChunk(chunk, max));
}

function splitOversizedChunk(text, max) {
  if (text.length <= max) return [text];
  return splitText(text, max);
}

function helpTextHtml() {
  return [
    b("Codex Telegram Bot"),
    "",
    b(t("commandsCore")),
    code("/menu"),
    code("/new"),
    code("/resume [thread-id|last]"),
    code("/status"),
    code("/queue"),
    code("/settings"),
    code("/tools"),
    code("/stop"),
    code("/help"),
    "",
    b(t("buttonPanels")),
    `${code("/menu")}: ${t("menuHelp")}`,
    `${code("/settings")}: ${t("settingsHelp")}`,
    `${code("/tools")}: ${t("toolsHelp")}`,
    `${code("/queue")}: ${t("queueHelp")}`,
    "",
    b(t("advancedCommands")),
    code("/threads"),
    code("/queue_pause /queue_resume /queue_mode_safe"),
    code("/model /reasoning /sandbox /approval"),
    code("/workdir /adddir /schema"),
    code("/logs /doctor /backup /export /cleanup"),
    "",
    "Inputs: text, Telegram photo, or image document."
  ].join("\n");
}

function b(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

function code(value) {
  return `<code>${escapeHtml(String(value))}</code>`;
}

function pre(value) {
  return `<pre>${escapeHtml(String(value))}</pre>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stripHtml(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function deleteMessageQuietly(ctx, messageId) {
  try {
    await ctx.deleteMessage(messageId);
  } catch {
    // Telegram may reject deletion for old messages or insufficient chat permissions.
  }
}

async function reactQuietly(ctx, emoji, isBig = false) {
  if (!runtimeValue("telegramReactionsEnabled") || !emoji || !ctx.message) return;
  try {
    await ctx.react(emoji, isBig);
  } catch (error) {
    console.warn("Telegram reaction failed:", error instanceof Error ? error.message : String(error));
  }
}

async function editMessageQuietly(ctx, messageId, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
  } catch {
    // Progress edits are best-effort.
  }
}

function parseOptionalJson(envName) {
  const value = process.env[envName]?.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${envName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeMultilineEnv(value) {
  return value?.trim().replaceAll("\\n", "\n") || "";
}

function parseCsv(value) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseOptionalBoolean(value) {
  if (value == null || value.trim() === "") return undefined;
  return parseRequiredBoolean(value, "boolean");
}

function parseLanguage(value) {
  const normalized = String(value || "en").trim().toLowerCase();
  return VALID.language.has(normalized) ? normalized : "en";
}

function parseTimeZone(value) {
  const normalized = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    return "UTC";
  }
}

function parseLocale(value) {
  const normalized = String(value || "en-US").trim() || "en-US";
  try {
    return Intl.getCanonicalLocales(normalized)[0] || "en-US";
  } catch {
    return "en-US";
  }
}

function uiLanguage() {
  return parseLanguage(state.ui?.language || config.telegramLanguage);
}

function uiTimeZone() {
  return parseTimeZone(state.ui?.timeZone || config.telegramTimeZone);
}

function uiLocale() {
  return parseLocale(state.ui?.locale || config.telegramLocale);
}

function t(key) {
  return textFor(uiLanguage(), key);
}

function parseRequiredBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be on or off.`);
}

function parseNonnegativeInteger(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseCodexAnswerFormat(value) {
  const normalized = value?.trim().toLowerCase() || "markdown";
  if (["off", "safe", "markdown"].includes(normalized)) return normalized;
  throw new Error("TELEGRAM_FORMAT_CODEX_ANSWERS must be off, safe, or markdown.");
}

function parseLiveProgressSource(value) {
  const normalized = value?.trim().toLowerCase() || "agent";
  if (VALID.liveProgressSource.has(normalized)) return normalized;
  throw new Error("TELEGRAM_LIVE_PROGRESS_SOURCE must be agent, activity, or both.");
}

function parseLiveProgressDeletePolicy(value) {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_") || "on_success";
  if (VALID.liveProgressDeletePolicy.has(normalized)) return normalized;
  throw new Error("TELEGRAM_LIVE_PROGRESS_DELETE_POLICY must be always, on_success, or never.");
}

function assertEnum(value, validValues, label) {
  if (!validValues.has(value)) throw new Error(`${label} must be one of: ${[...validValues].join(", ")}`);
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) counts[getKey(value)] = (counts[getKey(value)] ?? 0) + 1;
  return counts;
}

function unique(values) {
  return [...new Set(values)];
}

function chunk(values, size) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) {
    rows.push(values.slice(index, index + size));
  }
  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function formatOptional(value) {
  return typeof value === "boolean" ? String(value) : "default";
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

async function readOptionalText(file) {
  try {
    return redactText(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function redactValue(value) {
  return JSON.parse(redactText(JSON.stringify(value)));
}

function redactText(value) {
  let text = String(value);
  const token = config.telegramBotToken;
  if (token) text = text.replaceAll(token, "[REDACTED_TELEGRAM_TOKEN]");
  if (config.codexApiKey) text = text.replaceAll(config.codexApiKey, "[REDACTED_CODEX_API_KEY]");
  text = text.replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]");
  text = text.replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_SECRET]");
  return text;
}

function timestampForFilename(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function safeFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
}

function formatDurationSeconds(seconds) {
  let remaining = Math.floor(seconds);
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${remaining}s`);
  return parts.join(" ");
}
