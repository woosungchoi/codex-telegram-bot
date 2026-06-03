import MarkdownIt from "markdown-it";
import { code, escapeHtml, escapeHtmlAttribute, isSafeTelegramHref, pre } from "./html.js";
import { collapseExcessBlankLines, trimTrailingSpaces } from "../utils/text.js";

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
});

export function formatCodexAnswerSafeHtml(text) {
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

export function formatCodexAnswerMarkdownHtml(text) {
  const tokens = markdown.parse(stripUnsafeMarkdownLinks(text), {});
  return renderMarkdownTokens(tokens).trimEnd() || escapeHtml(text);
}

function stripUnsafeMarkdownLinks(text) {
  return String(text)
    .replace(/\[([^\]\n]+)\]\((?:javascript|data|vbscript):[^\n]*\)/gi, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, label, href) => (
      isSafeTelegramHref(href.trim()) ? match : label
    ));
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

function isAtListMarker(value) {
  return /(?:^|\n)(?:- |\d+\. )$/.test(value);
}
