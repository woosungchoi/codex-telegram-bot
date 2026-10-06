export function updateNativeProgress(current = {}, event) {
  if (event.type === "turn.plan") return { ...current, plan: (event.plan || []).slice(0, 30), explanation: String(event.explanation || "").slice(0, 2000) };
  if (event.type === "turn.diff") {
    const diff = String(event.diff || "");
    const files = [...new Set([...diff.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)].map((m) => m[1]).filter((p) => p !== "/dev/null"))].slice(0, 100);
    return { ...current, files, diff: diff.slice(0, 200_000), diffTruncated: diff.length > 200_000 };
  }
  if (event.type === "thread.status") return { ...current, status: event.status?.type, activeFlags: event.status?.activeFlags || [] };
  if (event.type === "usage.updated") return { ...current, tokenUsage: event.tokenUsage };
  if (["turn.completed", "turn.interrupted", "turn.failed"].includes(event.type)) return { ...current, status: event.type.split(".")[1], activeFlags: [] };
  return current;
}
