export function splitText(text, max) {
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

export function splitMarkdownAware(text, max) {
  if (text.length <= max) return [text];

  const chunks = [];
  let current = "";
  let inFence = false;
  let fenceOpener = "```\n";
  const lines = text.split(/(\n)/);

  for (let index = 0; index < lines.length; index += 2) {
    const line = `${lines[index] ?? ""}${lines[index + 1] ?? ""}`;
    const fenceMatchCount = (line.match(/```/g) ?? []).length;
    const isFenceBoundary = fenceMatchCount % 2 === 1;

    if (inFence && current && current.length + line.length > max) {
      chunks.push(...splitOversizedChunk(closeFenceChunk(current), max));
      current = "";
      if (isFenceBoundary) {
        inFence = false;
        continue;
      }
      current = fenceOpener;
    }

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
    if (isFenceBoundary) {
      if (!inFence) fenceOpener = line.match(/^```[^\n]*(?:\n|$)/)?.[0] ?? "```\n";
      inFence = !inFence;
    }

    if (!inFence && current.length >= max) {
      chunks.push(current.trimEnd());
      current = "";
    } else if (inFence && current.length >= max) {
      chunks.push(...splitOversizedChunk(closeFenceChunk(current), max));
      current = fenceOpener;
    }
  }

  if (current.trim()) chunks.push(inFence ? closeFenceChunk(current) : current.trimEnd());
  return chunks.flatMap((chunk) => splitOversizedChunk(chunk, max));
}

export function splitOversizedChunk(text, max) {
  if (text.length <= max) return [text];
  const fenced = text.match(/^(```[^\n]*\n)([\s\S]*?)(\n```)$/);
  if (fenced) {
    const [, opening, content, closing] = fenced;
    const contentMax = max - opening.length - closing.length;
    if (contentMax > 0) {
      return splitText(content.trimEnd(), contentMax).map((chunk) => `${opening}${chunk}${closing}`);
    }
  }
  return splitText(text, max);
}

function closeFenceChunk(value) {
  const trimmed = value.trimEnd();
  return trimmed.endsWith("```") ? trimmed : `${trimmed}\n\`\`\``;
}
