import https from "node:https";
import { stripHtml } from "./html.js";

export const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1_000;

const TELEGRAM_TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT"
]);

const HTML_PARSE_ERROR_PATTERN = /(?:can't parse entities|failed to parse|unsupported start tag|can't find end tag|unclosed start tag)/i;
const EDIT_UNAVAILABLE_PATTERN = /(?:message to edit not found|message (?:can't|cannot) be edited|message identifier is not specified|message_id_invalid)/i;
const RICH_REJECTION_PATTERN = /(?:sendrichmessage|rich_message|rich message|unsupported method|method (?:is )?not found|can't parse|failed to parse|message is too long)/i;
const MAX_ERROR_DESCRIPTION_CHARS = 500;

export function createTelegramApiAgent({ attemptTimeoutMs = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS } = {}) {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    autoSelectFamilyAttemptTimeout: attemptTimeoutMs
  });
}

export function sanitizeTelegramErrorMessage(value) {
  return String(value ?? "")
    .replace(/\/bot[^/\s]+\//gi, "/bot[REDACTED]/")
    .replace(/\b\d{5,}:[a-zA-Z0-9_-]{10,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .slice(0, MAX_ERROR_DESCRIPTION_CHARS);
}

export function summarizeTelegramError(error) {
  const apiCode = telegramApiCode(error);
  const transportCode = telegramTransportCode(error);
  const code = error?.code ?? error?.statusCode ?? apiCode ?? transportCode ?? null;
  const errno = error?.errno ?? transportCode ?? null;
  const type = typeof error?.type === "string" ? error.type : null;
  const description = sanitizeTelegramErrorMessage(
    error?.description
      ?? error?.response?.description
      ?? error?.message
      ?? error?.cause?.message
      ?? error
  );
  const retryAfter = numericOrNull(
    error?.parameters?.retry_after
      ?? error?.response?.parameters?.retry_after
  );
  const kind = isTelegramTransportError(error)
    ? "transport"
    : Number.isFinite(apiCode)
      ? "api"
      : "unknown";

  return {
    kind,
    code,
    errno,
    type,
    description,
    retryAfter,
    ambiguous: kind === "transport" || (Number.isFinite(apiCode) && apiCode >= 500)
  };
}

export function isTelegramTransportError(error) {
  const code = telegramTransportCode(error);
  if (code) return true;
  const description = String(
    error?.description
      ?? error?.response?.description
      ?? error?.message
      ?? error?.cause?.message
      ?? ""
  );
  return /(?:timed? ?out|network error|socket hang up|getaddrinfo|connection reset)/i.test(description);
}

export function shouldFallbackTelegramHtml(error) {
  return telegramApiCode(error) === 400 && HTML_PARSE_ERROR_PATTERN.test(telegramDescription(error));
}

export function isTelegramMessageNotModified(error) {
  return telegramApiCode(error) === 400 && /message is not modified/i.test(telegramDescription(error));
}

export function shouldReplyAfterTelegramEditFailure(error) {
  return telegramApiCode(error) === 400 && EDIT_UNAVAILABLE_PATTERN.test(telegramDescription(error));
}

export function shouldFallbackTelegramRich(error) {
  if (isTelegramTransportError(error)) return false;
  const code = telegramApiCode(error);
  if (code === 401 || code === 403 || code === 429 || (code !== null && code >= 500)) return false;
  if (code === 404) return true;
  return (code === 400 || code === null) && RICH_REJECTION_PATTERN.test(telegramDescription(error));
}

export async function replyTelegramHtml(ctx, html, extra = {}, options = {}) {
  try {
    return await ctx.reply(html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    if (!shouldFallbackTelegramHtml(error)) throw error;
    warnTelegramFallback(options.logger, "Telegram HTML reply rejected; falling back to plain text.", error);
    return ctx.reply(stripHtml(html), withoutParseMode(extra));
  }
}

export async function editOrReplyTelegramHtml(ctx, html, extra = {}, options = {}) {
  try {
    return await ctx.editMessageText(html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    if (isTelegramMessageNotModified(error)) return undefined;
    if (shouldFallbackTelegramHtml(error)) {
      warnTelegramFallback(options.logger, "Telegram HTML edit rejected; falling back to plain text.", error);
      try {
        return await ctx.editMessageText(stripHtml(html), withoutParseMode(extra));
      } catch (plainError) {
        if (isTelegramMessageNotModified(plainError)) return undefined;
        if (shouldReplyAfterTelegramEditFailure(plainError)) {
          return replyTelegramHtml(ctx, html, extra, options);
        }
        throw plainError;
      }
    }
    if (shouldReplyAfterTelegramEditFailure(error)) {
      return replyTelegramHtml(ctx, html, extra, options);
    }
    throw error;
  }
}

export async function sendTelegramHtml(telegram, chatId, html, extra = {}, options = {}) {
  try {
    return await telegram.sendMessage(chatId, html, { parse_mode: "HTML", ...extra });
  } catch (error) {
    if (!shouldFallbackTelegramHtml(error)) throw error;
    warnTelegramFallback(options.logger, "Telegram HTML send rejected; falling back to plain text.", error);
    return telegram.sendMessage(chatId, stripHtml(html), withoutParseMode(extra));
  }
}

export async function runTelegramProgressBestEffort(send, { onError, logger = console } = {}) {
  try {
    return { ok: true, value: await send(), errorSummary: null };
  } catch (error) {
    const errorSummary = summarizeTelegramError(error);
    if (onError) {
      try {
        await onError(errorSummary);
      } catch (journalError) {
        logger?.warn?.("Telegram progress failure journal write failed.", summarizeTelegramError(journalError));
      }
    }
    return { ok: false, value: undefined, errorSummary };
  }
}

export async function runTelegramFinalDelivery({
  onReady,
  onStarted,
  send,
  onCompleted,
  onFailed
} = {}) {
  let requestStarted = false;
  try {
    await onReady?.();
    await onStarted?.();
    requestStarted = true;
    const value = await send();
    await onCompleted?.(value);
    return { ok: true, value, requestStarted, error: null, errorSummary: null, recordError: null };
  } catch (error) {
    let recordError = null;
    try {
      await onFailed?.(error, { requestStarted });
    } catch (failureError) {
      recordError = failureError;
    }
    return {
      ok: false,
      value: undefined,
      requestStarted,
      error,
      errorSummary: summarizeTelegramError(error),
      recordError
    };
  }
}

function warnTelegramFallback(logger, message, error) {
  logger?.warn?.(message, summarizeTelegramError(error));
}

function withoutParseMode(extra) {
  const { parse_mode: _parseMode, ...plainExtra } = extra ?? {};
  return plainExtra;
}

function telegramDescription(error) {
  return String(
    error?.description
      ?? error?.response?.description
      ?? error?.message
      ?? error
      ?? ""
  );
}

function telegramApiCode(error) {
  const candidates = [
    error?.response?.error_code,
    error?.error_code,
    error?.statusCode,
    error?.response?.statusCode,
    typeof error?.code === "number" ? error.code : null
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function telegramTransportCode(error) {
  const candidates = [error?.errno, error?.code, error?.cause?.code, error?.cause?.errno];
  return candidates
    .map((candidate) => String(candidate ?? "").toUpperCase())
    .find((candidate) => TELEGRAM_TRANSPORT_CODES.has(candidate)) ?? "";
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
