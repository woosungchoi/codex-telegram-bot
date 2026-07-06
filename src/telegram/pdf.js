import path from "node:path";
import { b, code, escapeHtml } from "./html.js";

export const LAST_PDF_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isPdfDocument(document) {
  if (!document || typeof document !== "object") return false;
  const mime = String(document.mime_type || "").toLowerCase();
  const ext = path.extname(document.file_name || "").toLowerCase();
  return mime === "application/pdf" || ext === ".pdf";
}

export function planTelegramDocumentInput(document, caption = "", options = {}) {
  if (isPdfDocument(document)) {
    const text = String(caption || "").trim();
    return { kind: text ? "pdf_caption" : "pdf_upload_only", text };
  }
  if (document?.mime_type?.startsWith("image/")) {
    return { kind: "image", text: String(caption || "").trim() || options.imageFallbackText || "Analyze this image." };
  }
  return { kind: "unsupported" };
}

export function createUploadedPdfRecord(document, downloaded, options = {}) {
  return {
    path: downloaded.path,
    fileName: document?.file_name || path.basename(downloaded.path),
    bytes: Number.isFinite(downloaded.bytes) ? downloaded.bytes : document?.file_size,
    uploadedAt: options.uploadedAt || new Date().toISOString(),
    messageId: options.messageId
  };
}

export function formatUploadedPdfHtml(record, options = {}) {
  const labels = {
    file: "File",
    size: "Size",
    path: "Path",
    ...(options.labels || {})
  };
  const formatBytes = options.formatBytes || String;
  const parts = [
    b(options.title || "PDF uploaded"),
    options.detail ? escapeHtml(options.detail) : "",
    `${escapeHtml(labels.file)}: ${code(record.fileName || "document.pdf")}`,
    `${escapeHtml(labels.size)}: ${code(formatBytes(record.bytes || 0))}`,
    `${escapeHtml(labels.path)}: ${code(record.path)}`
  ];
  return parts.filter(Boolean).join("\n");
}

export function mergePdfReferences(text, records) {
  const pdfRecords = records.filter(isUsablePdfRecord);
  if (pdfRecords.length === 0) return text;
  return [
    "Use the following local PDF file(s) as context. Read the local path(s) directly with tools when needed. Do not send these files as image inputs.",
    "",
    "<local_pdf_files>",
    pdfRecords.map(formatPdfReferenceText).join("\n\n"),
    "</local_pdf_files>",
    "",
    text
  ].join("\n");
}

export function formatPdfReferenceText(record) {
  return [
    "Local PDF file saved from Telegram:",
    `- file name: ${record.fileName || "document.pdf"}`,
    `- path: ${record.path}`,
    Number.isFinite(record.bytes) ? `- bytes: ${record.bytes}` : "",
    record.uploadedAt ? `- uploaded at: ${record.uploadedAt}` : ""
  ].filter(Boolean).join("\n");
}

export function shouldUseRecentPdfUpload(text) {
  const value = String(text || "");
  return [
    /\b(?:this|the|last|recent|uploaded|attached)\s+pdf\b/i,
    /\b(?:this|last|recent|uploaded|attached)\s+document\b/i,
    /(?:이|해당|방금|최근|마지막|업로드한|첨부한)\s*(?:pdf|피디에프|문서)/i
  ].some((pattern) => pattern.test(value));
}

export function isFreshPdfUpload(record, options = {}) {
  if (!isUsablePdfRecord(record)) return false;
  const maxAgeMs = options.maxAgeMs ?? LAST_PDF_UPLOAD_MAX_AGE_MS;
  if (maxAgeMs <= 0) return true;
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const uploadedAt = Date.parse(record.uploadedAt || "");
  return Number.isFinite(uploadedAt) && Number.isFinite(now) && now - uploadedAt <= maxAgeMs;
}

function isUsablePdfRecord(record) {
  return Boolean(record && typeof record.path === "string" && record.path.trim());
}
