import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatOperationalStatus, readOperationalStatus } from "../src/operational_status.js";
import { textFor, SUPPORTED_LANGUAGES } from "../src/i18n.js";

const checkedAt = "2026-10-06T00:00:00Z";
const now = Date.parse(checkedAt);
const snapshot = (services = []) => ({ schema: 1, checkedAt, services });

test("ops preserves missing evidence, zero values and escapes collector HTML", () => {
  const html = formatOperationalStatus(snapshot([{
    name: '<service>&', status: 'unknown', reason: 'permission_missing',
    message: '<a href="https://example.com">unsafe</a>',
    metrics: [{ label: 'Errors', value: 0 }, { label: 'Restore', value: null }]
  }]), { now });
  assert.match(html, /&lt;service&gt;&amp;/);
  assert.ok(!html.includes('<a '));
  assert.match(html, /Read permission required/);
  assert.match(html, /Errors: 0/);
  assert.match(html, /Restore: Unknown/);
});

test("ops warns on stale/future snapshot and independently stale services", () => {
  assert.match(formatOperationalStatus(snapshot(), { now: now + 1800001 }), /Stale/);
  assert.match(formatOperationalStatus(snapshot(), { now: now - 1 }), /future/);
  const html = formatOperationalStatus(snapshot([{ name: 'Slow collector', status: 'ok', checkedAt: '2026-10-05T00:00:00Z' }]), { now });
  assert.match(html, /Recent snapshot/);
  assert.match(html, /Stale snapshot/);
});

test("ops follows locale and timezone and translates built-in statuses", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const text = (key) => textFor(language, key);
    const html = formatOperationalStatus(snapshot([{ name: 'Service', status: 'warning', reason: 'query_failed' }]), { text, now });
    assert.ok(html.includes(text('opsWarning')));
    assert.ok(html.includes(text('opsQueryFailed')));
  }
  const utc = formatOperationalStatus(snapshot(), { now, locale: 'en-GB', timeZone: 'UTC' });
  const seoul = formatOperationalStatus(snapshot(), { now, locale: 'ko-KR', timeZone: 'Asia/Seoul' });
  assert.match(utc, /00:00/);
  assert.match(seoul, /9:00/);
  assert.match(seoul, /Asia\/Seoul/);
});

test("ops validates schema, timestamps, services and metric values", () => {
  const invalid = [null, [], {}, { ...snapshot(), schema: 2 },
    { ...snapshot(), checkedAt: '2026-10-06' },
    { ...snapshot(), services: {} }, snapshot(Array(17).fill({ name: 'a', status: 'ok' })),
    snapshot([{ name: '', status: 'ok' }]), snapshot([{ name: 'a', status: 'success' }]),
    snapshot([{ name: 'a', status: 'ok', reason: 'toString' }]),
    snapshot([{ name: 'a', status: 'ok', metrics: [{ label: 'a', value: {} }] }]),
    snapshot([{ name: 'a', status: 'ok', metrics: [{ label: 'a', value: NaN }] }]),
    snapshot([{ name: 'a', status: 'ok', metrics: [{ label: 'a', value: 'x'.repeat(501) }] }])];
  for (const data of invalid) assert.throws(() => formatOperationalStatus(data, { now }));
});

test("long ops output stays bounded without broken HTML entities or tags", () => {
  const services = Array.from({ length: 16 }, (_, i) => ({
    name: `Service ${i}`, status: 'ok',
    metrics: Array.from({ length: 16 }, () => ({ label: '<'.repeat(100), value: '"'.repeat(500) }))
  }));
  const html = formatOperationalStatus(snapshot(services), { now });
  assert.ok(html.length <= 3500);
  assert.match(html, /More data omitted/);
  assert.equal((html.match(/<b>/g) ?? []).length, (html.match(/<\/b>/g) ?? []).length);
  assert.ok(!html.replaceAll(/&(amp|lt|gt|quot);/g, '').includes('&'));
});

test("ops file reader handles disabled, valid, missing, malformed and oversized input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-test-'));
  try {
    assert.match(await readOperationalStatus(''), /disabled/);
    assert.match(await readOperationalStatus(path.join(dir, 'missing')), /Cannot read/);
    const file = path.join(dir, 'status.json');
    await writeFile(file, JSON.stringify(snapshot()), { mode: 0o600 });
    assert.match(await readOperationalStatus(file, { now }), /Recent snapshot/);
    await writeFile(file, '{');
    assert.match(await readOperationalStatus(file), /Cannot read/);
    await writeFile(file, 'x'.repeat(128 * 1024 + 1));
    assert.match(await readOperationalStatus(file), /Cannot read/);
    await mkdir(path.join(dir, 'folder'));
    assert.match(await readOperationalStatus(path.join(dir, 'folder')), /Cannot read/);
    const ko = await readOperationalStatus(file, { text: (key) => textFor('ko', key) });
    assert.match(ko, /읽을 수 없습니다/);
    assert.ok(!ko.includes(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ops rejects symlinks and FIFOs without blocking", { skip: process.platform !== 'linux', timeout: 2000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-types-'));
  try {
    const target = path.join(dir, 'target');
    await writeFile(target, JSON.stringify(snapshot()));
    await symlink(target, path.join(dir, 'link'));
    assert.match(await readOperationalStatus(path.join(dir, 'link')), /Cannot read/);
    execFileSync('mkfifo', [path.join(dir, 'fifo')]);
    assert.match(await readOperationalStatus(path.join(dir, 'fifo')), /Cannot read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
