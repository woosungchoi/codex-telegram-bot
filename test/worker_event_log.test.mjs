import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEventLogReader } from "../src/worker/event_log.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    file: path.join(root, "events.jsonl"),
    read: createEventLogReader({ maxFiles: 2, maxCheckpoints: 4 }),
  };
}
const rows = (n) =>
  Array.from(
    { length: n },
    (_, i) => JSON.stringify({ seq: i + 1, text: `한국어🙂${i}` }) + "\n",
  ).join("");

test("indexed event reads retain pagination and independent replay after appends", async (t) => {
  const { file, read } = await fixture(t);
  await fs.writeFile(file, rows(1500));
  for (const afterSeq of [1500, 1200, 0, 499, 1490, 1500, 100]) {
    const events = await read(file, { afterSeq, limit: 7 });
    assert.deepEqual(
      events.map((e) => e.seq),
      Array.from(
        { length: Math.min(7, 1500 - afterSeq) },
        (_, i) => afterSeq + i + 1,
      ),
    );
  }
  await fs.appendFile(file, '{"seq":1501,"text":"새🙂"}\n');
  assert.deepEqual(await read(file, { afterSeq: 1500 }), [
    { seq: 1501, text: "새🙂" },
  ]);
  assert.equal((await read(file, { afterSeq: 0 }))[0].text, "한국어🙂0");
});

test("replacement, equal-size rewrite, truncation and disappearance invalidate offsets", async (t) => {
  const { file, read } = await fixture(t);
  await fs.writeFile(file, rows(1500));
  await read(file, { afterSeq: 1500 });
  await fs.writeFile(file + ".new", '{"seq":2}\n');
  await fs.rename(file + ".new", file);
  assert.deepEqual(await read(file), [{ seq: 2 }]);
  await fs.writeFile(file, '{"seq":3}\n');
  assert.deepEqual(await read(file), [{ seq: 3 }]);
  await fs.truncate(file, 0);
  assert.deepEqual(await read(file), []);
  await fs.rm(file);
  await assert.rejects(read(file), { code: "ENOENT" });
  await fs.writeFile(file, rows(1));
  assert.equal((await read(file))[0].seq, 1);
});

test("partial UTF-8 records are retried, valid newline-less tails are not duplicated", async (t) => {
  const { file, read } = await fixture(t);
  const next = Buffer.from('{"seq":2,"text":"🙂"}');
  await fs.writeFile(
    file,
    Buffer.concat([Buffer.from(rows(1)), next.subarray(0, -3)]),
  );
  assert.equal((await read(file)).length, 1);
  await fs.appendFile(file, next.subarray(-3));
  assert.deepEqual(await read(file, { afterSeq: 1 }), [{ seq: 2, text: "🙂" }]);
  await fs.appendFile(file, '\n{"seq":3}\n');
  assert.deepEqual(
    (await read(file)).map((e) => e.seq),
    [1, 2, 3],
  );
});

test("a corrupt suffix is detected even behind a small page or EOF cursor", async (t) => {
  const { file, read } = await fixture(t);
  await fs.writeFile(file, rows(1500));
  await read(file, { afterSeq: 1500 });
  await fs.appendFile(file, "{broken}\n");
  await assert.rejects(read(file, { afterSeq: 99999 }), SyntaxError);
  await assert.rejects(read(file, { limit: 1 }), SyntaxError);
});

test("non-monotonic legacy sequences and cache eviction do not lose events", async (t) => {
  const { file, root, read } = await fixture(t);
  await fs.writeFile(
    file,
    rows(1024) + '{"seq":9999}\n{"seq":1}\n{"seq":9000}\n',
  );
  assert.deepEqual(
    (await read(file, { afterSeq: 8500 })).map((e) => e.seq),
    [9999, 9000],
  );
  for (let i = 0; i < 4; i++) {
    const f = path.join(root, `${i}.jsonl`);
    await fs.writeFile(f, rows(1));
    await read(f);
  }
  assert.equal((await read(file, { afterSeq: 1024 })).length, 2);
});
