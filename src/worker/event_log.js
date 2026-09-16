import fs from "node:fs/promises";

// Sparse byte offsets, not event bodies or open descriptors, are retained.
// Worker logs are append-only; atomic replacement and truncation reset the index.
export function createEventLogReader({
  maxFiles = 64,
  maxCheckpoints = 1024,
} = {}) {
  const indexes = new Map();
  return async function read(file, { afterSeq = 0, limit = 500 } = {}) {
    const after = Number(afterSeq || 0);
    const count = Math.max(0, Math.trunc(Number(limit) || 0));
    let handle;
    try {
      handle = await fs.open(file, "r");
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile())
        throw new Error("Worker event log must be a regular file.");
      const size = Number(stat.size);
      let index = indexes.get(file);
      if (
        !index ||
        index.dev !== stat.dev ||
        index.ino !== stat.ino ||
        size < index.size ||
        (size === index.size &&
          (index.mtime !== stat.mtimeNs || index.ctime !== stat.ctimeNs))
      ) {
        index = {
          dev: stat.dev,
          ino: stat.ino,
          size: -1,
          offset: 0,
          rows: 0,
          maxSeq: -Infinity,
          tailMaxSeq: -Infinity,
          stride: 128,
          points: [{ offset: 0, maxSeq: -Infinity }],
        };
      }
      if (size !== index.size) {
        index.tailMaxSeq = -Infinity;
        // Validate the entire new suffix even when the requested page is small.
        // Corrupt complete records must never be hidden by a cursor or limit.
        for await (const line of records(handle, index.offset, size)) {
          const seq =
            line.event === undefined ? -Infinity : Number(line.event.seq || 0);
          if (!line.complete) {
            if (!Number.isNaN(seq)) index.tailMaxSeq = seq;
            continue;
          }
          index.offset = line.end;
          if (!Number.isNaN(seq)) index.maxSeq = Math.max(index.maxSeq, seq);
          index.rows += 1;
          if (index.rows % index.stride === 0) {
            index.points.push({ offset: line.end, maxSeq: index.maxSeq });
            if (index.points.length > Math.max(2, maxCheckpoints)) {
              index.points = index.points.filter((_, i) => i % 2 === 0);
              index.stride *= 2;
            }
          }
        }
        index.size = size;
        index.mtime = stat.mtimeNs;
        index.ctime = stat.ctimeNs;
      }
      indexes.delete(file);
      indexes.set(file, index);
      while (indexes.size > Math.max(1, maxFiles))
        indexes.delete(indexes.keys().next().value);
      if (
        !count ||
        Number.isNaN(after) ||
        after >= Math.max(index.maxSeq, index.tailMaxSeq)
      )
        return [];
      let offset = 0;
      for (const point of index.points) {
        // Prefix maxima also support old/non-monotonic logs without losing rows.
        if (point.maxSeq > after) break;
        offset = point.offset;
      }
      const events = [];
      for await (const { event } of records(handle, offset, size)) {
        if (event !== undefined && Number(event.seq || 0) > after)
          events.push(event);
        if (events.length >= count) break;
      }
      return events;
    } catch (error) {
      indexes.delete(file);
      throw error;
    } finally {
      await handle?.close();
    }
  };
}

async function* records(handle, start, size) {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = start;
  let fragments = [];
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (!bytesRead) break;
    let begin = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] !== 10) continue;
      const part = buffer.subarray(begin, i);
      const body = fragments.length
        ? Buffer.concat([...fragments, part]).toString("utf8")
        : part.toString("utf8");
      fragments = [];
      yield {
        event: body ? JSON.parse(body) : undefined,
        end: position + i + 1,
        complete: true,
      };
      begin = i + 1;
    }
    if (begin < bytesRead)
      fragments.push(Buffer.from(buffer.subarray(begin, bytesRead)));
    position += bytesRead;
  }
  if (fragments.length) {
    const body = Buffer.concat(fragments).toString("utf8");
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return;
    } // only the unfinished tail is tolerated
    yield { event, end: position, complete: false };
  }
}
