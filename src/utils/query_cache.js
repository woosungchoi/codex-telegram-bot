// Small, process-local cache. No timers, credentials or failed results are retained.
export function createQueryCache({
  ttlMs = 3000,
  maxEntries = 128,
  now = Date.now,
} = {}) {
  const entries = new Map();
  function clear() {
    entries.clear();
  }
  async function get(key, load, { fresh = false } = {}) {
    let entry = entries.get(key);
    if (
      entry &&
      ((!fresh && (entry.pending || entry.expiresAt > now())) ||
        (fresh && entry.pending && entry.fresh))
    ) {
      entries.delete(key);
      entries.set(key, entry);
      return globalThis.structuredClone(await entry.promise);
    }
    entry = { pending: true, fresh, expiresAt: 0 };
    entry.promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          entry.pending = false;
          entry.expiresAt = now() + ttlMs;
          return value;
        },
        (error) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
    entries.set(key, entry);
    while (entries.size > maxEntries)
      entries.delete(entries.keys().next().value);
    return globalThis.structuredClone(await entry.promise);
  }
  return { get, clear };
}
