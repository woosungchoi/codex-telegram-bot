export function b(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

export function code(value) {
  return `<code>${escapeHtml(String(value))}</code>`;
}

export function pre(value, language = "") {
  const body = escapeHtml(String(value));
  const name = String(language).trim().split(/\s+/, 1)[0].toLowerCase();
  // Fence info is untrusted metadata, not text to prepend to executable code.
  if (!/^[a-z0-9][a-z0-9_+.#-]{0,63}$/.test(name)) return `<pre>${body}</pre>`;
  return `<pre><code class="language-${name}">${body}</code></pre>`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function stripHtml(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function isSafeTelegramHref(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}
