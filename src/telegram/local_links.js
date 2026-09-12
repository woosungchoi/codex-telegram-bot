import MarkdownIt from "markdown-it";

const { helpers } = new MarkdownIt();

// Telegram cannot open server-local paths. Keep the destination visible without
// inventing a public URL or uploading the referenced file.
export function formatTelegramLocalFileLinks(text) {
  return mapMarkdownInlineLinks(text, ({ source, label, href, image }) => {
    if (image || !isLocalFileHref(href)) return source;
    const longestRun = Math.max(0, ...(href.match(/`+/g) ?? []).map((run) => run.length));
    const delimiter = "`".repeat(longestRun + 1);
    const padding = /^[` ]|[` ]$/.test(href) ? " " : "";
    return `${label} (${delimiter}${padding}${href}${padding}${delimiter})`;
  });
}

function isLocalFileHref(href) {
  return /^(?:\/(?!\/)|\.\.?\/|~\/|file:|[a-z]:[\\/])/i.test(href);
}

// Work on inline links only: fenced/indented code, code spans, image syntax,
// balanced destinations, angle-wrapped paths and optional titles retain their
// Markdown meaning. Reference-style links are left to the renderer.
export function mapMarkdownInlineLinks(text, transform) {
  const source = String(text ?? "");
  let output = "";
  let copied = 0;
  let fence;

  for (let pos = 0; pos < source.length;) {
    const lineEnd = source.indexOf("\n", pos);
    const end = lineEnd < 0 ? source.length : lineEnd;
    if (pos === 0 || source[pos - 1] === "\n") {
      const line = source.slice(pos, end);
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
        pos = end + 1;
        continue;
      }
      if (marker || /^(?: {4}|\t)/.test(line)) {
        if (marker) fence = marker[1];
        pos = end + 1;
        continue;
      }
    }

    if (source[pos] === "\\") {
      pos += 2;
      continue;
    }
    if (source[pos] === "`") {
      const run = source.slice(pos).match(/^`+/)[0];
      let next = source.indexOf(run, pos + run.length);
      while (next >= 0 && (source[next - 1] === "`" || source[next + run.length] === "`")) next = source.indexOf(run, next + run.length);
      pos = next >= 0 ? next + run.length : pos + run.length;
      continue;
    }

    const image = source[pos] === "!" && source[pos + 1] === "[";
    const start = pos + (image ? 1 : 0);
    if (source[start] !== "[") {
      pos += 1;
      continue;
    }
    let close = start + 1;
    let depth = 1;
    for (; close < end && depth; close += 1) {
      if (source[close] === "\\") close += 1;
      else if (source[close] === "[") depth += 1;
      else if (source[close] === "]") depth -= 1;
    }
    if (depth || source[close] !== "(") {
      pos += 1;
      continue;
    }
    const destinationStart = close + 1 + (source.slice(close + 1, end).match(/^[ \t]*/)[0].length);
    const destination = helpers.parseLinkDestination(source, destinationStart, end);
    let finish = destination.pos;
    while (/[ \t]/.test(source[finish] ?? "")) finish += 1;
    if (destination.ok && finish > destination.pos && source[finish] !== ")") {
      const title = helpers.parseLinkTitle(source, finish, end);
      if (title.ok) finish = title.pos;
      while (/[ \t]/.test(source[finish] ?? "")) finish += 1;
    }
    if (!destination.ok || source[finish] !== ")") {
      pos += 1;
      continue;
    }
    finish += 1;
    output += source.slice(copied, pos) + transform({
      source: source.slice(pos, finish),
      label: source.slice(start + 1, close - 1),
      href: destination.str,
      image
    });
    copied = finish;
    pos = finish;
  }
  return output + source.slice(copied);
}
