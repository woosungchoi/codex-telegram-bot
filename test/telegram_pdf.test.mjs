import test from "node:test";
import assert from "node:assert/strict";
import {
  createUploadedPdfRecord,
  formatUploadedPdfHtml,
  isFreshPdfUpload,
  isPdfDocument,
  mergePdfReferences,
  planTelegramDocumentInput,
  shouldUseRecentPdfUpload
} from "../src/telegram/pdf.js";

test("PDF documents are recognized by MIME type or filename", () => {
  assert.equal(isPdfDocument({ mime_type: "application/pdf", file_name: "report.bin" }), true);
  assert.equal(isPdfDocument({ mime_type: "application/octet-stream", file_name: "REPORT.PDF" }), true);
  assert.equal(isPdfDocument({ mime_type: "image/png", file_name: "chart.png" }), false);
});

test("document input planning keeps PDF-only uploads out of Codex turns", () => {
  const plan = planTelegramDocumentInput({ mime_type: "application/pdf", file_name: "report.pdf" }, "");
  assert.deepEqual(plan, { kind: "pdf_upload_only", text: "" });
});

test("document input planning runs PDF captions as text-only Codex turns", () => {
  const plan = planTelegramDocumentInput({ mime_type: "application/pdf", file_name: "report.pdf" }, " summarize ");
  assert.deepEqual(plan, { kind: "pdf_caption", text: "summarize" });
});

test("document input planning preserves image document behavior", () => {
  const plan = planTelegramDocumentInput({ mime_type: "image/png", file_name: "chart.png" }, "");
  assert.deepEqual(plan, { kind: "image", text: "Analyze this image." });
});

test("uploaded PDF HTML escapes metadata and includes the local path", () => {
  const html = formatUploadedPdfHtml(
    { fileName: "a<b>.pdf", bytes: 1024, path: "/tmp/a&b.pdf" },
    { formatBytes: (bytes) => `${bytes} B` }
  );
  assert.match(html, /<b>PDF uploaded<\/b>/);
  assert.match(html, /<code>a&lt;b&gt;.pdf<\/code>/);
  assert.match(html, /<code>\/tmp\/a&amp;b\.pdf<\/code>/);
});

test("PDF references are merged into text without local_image entries", () => {
  const text = mergePdfReferences("Summarize it.", [{
    fileName: "report.pdf",
    bytes: 12,
    path: "/uploads/report.pdf",
    uploadedAt: "2026-07-06T00:00:00.000Z"
  }]);
  assert.match(text, /<local_pdf_files>/);
  assert.match(text, /\/uploads\/report\.pdf/);
  assert.doesNotMatch(text, /local_image/);
});

test("recent PDF opt-in only triggers on explicit references", () => {
  assert.equal(shouldUseRecentPdfUpload("Summarize the uploaded PDF."), true);
  assert.equal(shouldUseRecentPdfUpload("이 PDF 요약해 주세요."), true);
  assert.equal(shouldUseRecentPdfUpload("Summarize the meeting."), false);
});

test("recent PDF records expire after the configured age", () => {
  const record = createUploadedPdfRecord(
    { file_name: "report.pdf" },
    { path: "/uploads/report.pdf", bytes: 10 },
    { uploadedAt: "2026-07-06T00:00:00.000Z" }
  );
  assert.equal(isFreshPdfUpload(record, { now: new Date("2026-07-06T23:00:00.000Z") }), true);
  assert.equal(isFreshPdfUpload(record, { now: new Date("2026-07-07T01:00:01.000Z") }), false);
});
