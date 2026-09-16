import { createMessageFormatter } from "../i18n.js";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PHOTO_ARTIFACT_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
export const DEFAULT_PHOTO_ARTIFACT_MAX = 5;
export const DEFAULT_PHOTO_ARTIFACT_ROOTS = [
  "/home/openclaw/.openclaw/workspace/reports/codex",
  "/home/openclaw/.openclaw/workspace"
];

export async function extractTelegramPhotoArtifacts(text, options = {}) {
  const source = String(text ?? "");
  const candidates = [];
  const keptLines = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of source.split("\n")) {
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      keptLines.push(line);
      continue;
    }

    if (!inFence) {
      const directive = parseTelegramPhotoDirective(line);
      if (directive) {
        candidates.push(directive);
        continue;
      }

      const markdownImage = parseStandaloneMarkdownImage(line);
      if (markdownImage) {
        candidates.push(markdownImage);
        continue;
      }
    }

    keptLines.push(line);
  }

  const resolved = await resolvePhotoArtifactCandidates(candidates, options);
  return {
    text: trimExcessBlankLines(keptLines.join("\n")),
    photos: resolved.photos,
    rejected: resolved.rejected
  };
}

export function parseTelegramPhotoDirective(line) {
  const match = String(line ?? "").match(/^\s*\[\[telegram_photo:(.+)\]\]\s*$/);
  if (!match) return undefined;

  const [rawPath, rawCaption] = splitCaption(match[1]);
  return {
    path: rawPath.trim(),
    caption: normalizeCaption(rawCaption)
  };
}

export function parseStandaloneMarkdownImage(line) {
  const match = String(line ?? "").match(/^\s*!\[([^\]\n]*)\]\((\/[^)\n]+)\)\s*$/);
  if (!match) return undefined;

  return {
    path: match[2].trim(),
    caption: normalizeCaption(match[1])
  };
}

export async function resolvePhotoArtifactCandidates(candidates, options = {}) {
  const maxPhotos = options.maxPhotos ?? DEFAULT_PHOTO_ARTIFACT_MAX;
  const allowedRoots = normalizeAllowedRoots(options.allowedRoots ?? DEFAULT_PHOTO_ARTIFACT_ROOTS);
  const allowedExtensions = options.allowedExtensions ?? DEFAULT_PHOTO_ARTIFACT_EXTENSIONS;
  const photos = [];
  const rejected = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const resolved = path.resolve(String(candidate.path ?? ""));
    const extension = path.extname(resolved).toLowerCase();

    if (!path.isAbsolute(candidate.path ?? "")) {
      rejected.push({ ...candidate, reason: "not_absolute_path" });
      continue;
    }
    if (!allowedExtensions.has(extension)) {
      rejected.push({ ...candidate, path: resolved, reason: "unsupported_extension" });
      continue;
    }
    if (!isPathInsideAllowedRoots(resolved, allowedRoots)) {
      rejected.push({ ...candidate, path: resolved, reason: "outside_allowed_roots" });
      continue;
    }
    if (seen.has(resolved)) continue;
    if (photos.length >= maxPhotos) {
      rejected.push({ ...candidate, path: resolved, reason: "too_many_photos" });
      continue;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        rejected.push({ ...candidate, path: resolved, reason: "not_a_file" });
        continue;
      }
    } catch {
      rejected.push({ ...candidate, path: resolved, reason: "missing_file" });
      continue;
    }

    seen.add(resolved);
    photos.push({
      path: resolved,
      caption: candidate.caption
    });
  }

  return { photos, rejected };
}

export function formatRejectedPhotoArtifacts(rejected, text) {
  const msg = createMessageFormatter(text);
  if (!rejected?.length) return "";
  return rejected
    .map((item) => msg("ui.photoArtifactRejected", { path: `\`${item.path}\``, reason: msg(`photoRejection.${item.reason}`) }))
    .join("\n");
}

function splitCaption(value) {
  const marker = "|caption=";
  const index = value.indexOf(marker);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + marker.length)];
}

function normalizeCaption(value) {
  const caption = String(value ?? "").trim();
  return caption ? caption.slice(0, 1024) : undefined;
}

function normalizeAllowedRoots(roots) {
  return [...roots].map((root) => path.resolve(root));
}

function isPathInsideAllowedRoots(filePath, roots) {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
}

function trimExcessBlankLines(text) {
  return String(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
