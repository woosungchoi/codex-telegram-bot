import MarkdownIt from "markdown-it";
import { b, code, escapeHtml, escapeHtmlAttribute, isSafeTelegramHref, pre } from "./html.js";
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

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
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
    } else if (token.type === "table_open") {
      if (html && !html.endsWith("\n")) html += "\n";
      const table = renderTableTokens(tokens, i);
      html += table.html;
      if (!html.endsWith("\n")) html += "\n";
      i = table.endIndex;
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      html += "\n";
    } else if (token.type === "html_block") {
      html += escapeHtml(token.content);
    }
  }

  return collapseExcessBlankLines(html);
}

function renderTableTokens(tokens, startIndex) {
  const rows = [];
  let currentRow = null;
  let endIndex = startIndex;

  for (let i = startIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    endIndex = i;
    if (token.type === "table_close") break;

    if (token.type === "tr_open") {
      currentRow = [];
    } else if (token.type === "tr_close") {
      if (currentRow) rows.push(currentRow);
      currentRow = null;
    } else if ((token.type === "th_open" || token.type === "td_open") && currentRow) {
      const inline = tokens[i + 1]?.type === "inline" ? tokens[i + 1] : null;
      currentRow.push({
        html: renderInlineTokens(inline?.children ?? []),
        text: renderInlineText(inline?.children ?? [])
      });
    }
  }

  return { html: renderTableRows(rows), endIndex };
}

function renderTableRows(rows) {
  if (!rows.length) return "";
  const headers = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  if (!bodyRows.length) return renderWideTableRows(rows);
  if (headers.length === 2 && bodyRows.every((row) => row.length === 2)) {
    return renderTwoColumnRows(headers, bodyRows);
  }
  return renderWideTableRows(rows);
}

function renderTwoColumnRows(headers, rows) {
  const [leftHeader, rightHeader] = headers.map((cell, index) => cell.html || `Column ${index + 1}`);
  const lines = [];
  for (const row of rows) {
    const [left, right] = row;
    lines.push(`- ${b(`${stripHtmlTags(leftHeader)}:`)} ${left.html}`);
    lines.push(`  ${b(`${stripHtmlTags(rightHeader)}:`)} ${right.html}`);
    lines.push("");
  }
  return trimTrailingSpaces(lines.join("\n"));
}

function renderWideTableRows(rows) {
  const textRows = rows.map((row) => row.map((cell) => cell.text));
  const widths = [];
  for (const row of textRows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  const lines = textRows.map((row) => (
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")
  ));
  if (lines.length > 1) {
    lines.splice(1, 0, widths.map((width) => "-".repeat(Math.max(3, width))).join(" | "));
  }
  return pre(lines.join("\n"));
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

function renderInlineText(tokens) {
  let text = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") {
      text += token.content;
    } else if (token.type === "softbreak" || token.type === "hardbreak") {
      text += "\n";
    } else if (token.children?.length) {
      text += renderInlineText(token.children);
    }
  }
  return text;
}

function stripHtmlTags(value) {
  return String(value).replace(/<[^>]+>/g, "");
}

function isAtListMarker(value) {
  return /(?:^|\n)(?:- |\d+\. )$/.test(value);
}
