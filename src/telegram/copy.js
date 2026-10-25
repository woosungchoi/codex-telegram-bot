import MarkdownIt from "markdown-it";
import { createMessageFormatter } from "../i18n.js";

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
const MAX_COPY_CHARS = 256;
const MAX_COPY_BUTTONS = 20;

// Parse the original answer, never fragments manufactured by message splitting.
export function codeCopyReplyMarkup(markdown, translate) {
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const msg = createMessageFormatter(translate);
  const blocks = [];
  let index = 0;
  for (const token of parser.parse(source, {})) {
    if (token.type !== "fence") continue;
    index += 1;
    // Nested/container fences need indentation reconstruction; fail closed.
    if (token.level !== 0 || !token.map) continue;
    const closing = lines[token.map[1] - 1]?.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/);
    if (token.map[1] - token.map[0] < 2 || !closing
      || closing[1][0] !== token.markup[0] || closing[1].length < token.markup.length) continue;
    // Only remove the structural newline before the closing fence.
    const text = token.content.replace(/\n$/, "");
    if (!text.trim() || [...text].length > MAX_COPY_CHARS) continue;
    blocks.push({ index, text });
    if (blocks.length === MAX_COPY_BUTTONS) break;
  }
  if (!blocks.length) return undefined;
  return {
    inline_keyboard: blocks.map(({ index: number, text }) => [{
      text: msg("ui.copyCodeNumber", { number }),
      copy_text: { text }
    }])
  };
}
