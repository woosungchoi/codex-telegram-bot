export const RICH_MESSAGE_MAX_CHARS = 32768;

export function cleanUndefinedPayloadFields(value) {
  if (Array.isArray(value)) return value.map(cleanUndefinedPayloadFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, cleanUndefinedPayloadFields(entry)])
  );
}

export function telegramThreadIdFromContext(ctx) {
  const message = ctx?.msg ?? ctx?.message ?? ctx?.update?.message ?? ctx?.callbackQuery?.message;
  return message?.is_topic_message ? message.message_thread_id : undefined;
}

export function buildRichMarkdownPayload(ctx, markdown, extra = {}) {
  const preparedMarkdown = prepareRichMarkdown(markdown);
  const replyParameters = extra.reply_parameters
    ?? (extra.replyToMessageId ? { message_id: extra.replyToMessageId } : undefined);
  return cleanUndefinedPayloadFields({
    chat_id: extra.chat_id ?? ctx?.chat?.id,
    message_thread_id: extra.message_thread_id ?? telegramThreadIdFromContext(ctx),
    rich_message: { markdown: preparedMarkdown },
    reply_parameters: replyParameters
  });
}

export async function tryReplyRichMarkdown(ctx, markdown, extra = {}) {
  const text = String(markdown ?? "");
  if (Buffer.byteLength(text, "utf8") > RICH_MESSAGE_MAX_CHARS) {
    return { sent: false, fallback: true, reason: "too_long" };
  }

  try {
    const payload = buildRichMarkdownPayload(ctx, text, extra);
    const message = await ctx.telegram.callApi("sendRichMessage", payload);
    return { sent: true, fallback: false, message };
  } catch (error) {
    if (shouldFallbackFromRichError(error)) {
      const errorSummary = summarizeRichError(error);
      extra.logger?.warn?.(
        "Telegram rich message rejected; falling back to HTML renderer.",
        { ...errorSummary, bytes: Buffer.byteLength(text, "utf8") }
      );
      return { sent: false, fallback: true, reason: "rich_rejected", error, errorSummary };
    }
    throw error;
  }
}

export function prepareRichMarkdown(markdown) {
  return promoteStandaloneInlineCode(markdown);
}

export function promoteStandaloneInlineCode(markdown) {
  const lines = String(markdown ?? "").split("\n");
  let inFence = false;
  let fenceMarker = "";

  return lines.map((line) => {
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0];
      } else if (marker[0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      return line;
    }

    if (inFence) return line;

    const codeMatch = line.match(/^(\s*)`([^`\n]{1,200})`\s*$/);
    if (!codeMatch) return line;

    const [, indent, code] = codeMatch;
    if (!code.trim()) return line;
    return `${indent}\`\`\`\n${indent}${code}\n${indent}\`\`\``;
  }).join("\n");
}

export function shouldFallbackFromRichError(error) {
  const code = error?.code ?? error?.statusCode ?? error?.response?.statusCode;
  if (code === 400 || code === 404) return true;

  const message = String(error?.description ?? error?.message ?? error ?? "").toLowerCase();
  if (!message) return false;
  if (/(timed? ?out|econnreset|econnrefused|eai_again|enotfound|network|socket hang up)/i.test(message)) {
    return false;
  }
  return (
    message.includes("bad request")
    || message.includes("not found")
    || message.includes("method")
    || message.includes("unsupported")
    || message.includes("rich_message")
    || message.includes("rich message")
    || message.includes("can't parse")
    || message.includes("failed to parse")
    || message.includes("message is too long")
  );
}

export function summarizeRichError(error) {
  const code = error?.code ?? error?.statusCode ?? error?.response?.statusCode;
  const description = String(error?.description ?? error?.response?.description ?? error?.message ?? error ?? "");
  return cleanUndefinedPayloadFields({ code, description });
}
