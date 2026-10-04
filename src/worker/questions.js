import { randomUUID } from "node:crypto";

// The worker owns both the pending RPC and its durable answer cursor. The bot
// never resolves a question merely because a Telegram message was delivered.
export function createQuestionBroker({ store, controllers }) {
  const pending = new Map();
  const locks = new Map();
  async function locked(id, fn) {
    const prior = locks.get(id) || Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    locks.set(id, task);
    try { return await task; } finally { if (locks.get(id) === task) locks.delete(id); }
  }
  async function ask(job, request, signal) {
    if (signal.aborted) throw new Error("Question interrupted");
    if (request.params?.isBlocking !== true) throw new Error("Non-blocking questions cannot authorize execution. Ask a blocking question.");
    const questions = request.params.questions?.map((q) => ({ ...q, options: q.options?.map((o) => typeof o === "string" ? { label: o, description: "" } : o) }));
    if (!Array.isArray(questions) || !questions.length || questions.length > 20
      || questions.some((q) => typeof q.id !== "string" || !q.id || typeof q.question !== "string" || !q.question || q.isSecret || (q.options?.length || 0) > 20 || q.options?.some((o) => typeof o?.label !== "string" || !o.label || o.label.length > 80))
      || questions.some((q) => JSON.stringify(q).length > 3200)
      || new Set(questions.map((q) => q.id)).size !== questions.length) {
      throw new Error("Invalid question batch; secrets must not be requested in Telegram.");
    }
    if (!job.requesterUserId) throw new Error("Interactive questions require an identified requesting user.");
    if (pending.has(job.id)) throw new Error("A question is already pending for this job.");
    let resolve, reject;
    const answer = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Install the rejection observer before any asynchronous persistence.
    answer.catch(() => {});
    const entry = { resolve, reject };
    pending.set(job.id, entry);
    const abort = () => reject(new Error("Question interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      await store.writeJobState({ id: job.id, userQuestion: {
        id: randomUUID().replaceAll("-", ""), state: "pending", index: 0,
        questions, answers: {}, threadId: request.params.threadId,
        turnId: request.params.turnId, requestId: request.id,
        createdAt: new Date().toISOString()
      } });
      if (signal.aborted) abort();
      return await answer;
    } finally {
      signal.removeEventListener("abort", abort);
      if (pending.get(job.id) === entry) pending.delete(job.id);
      await locked(job.id, async () => {
        const current = (await store.readJobState(job.id))?.userQuestion;
        if (current?.state === "pending") await store.writeJobState({ id: job.id, userQuestion: { ...current, state: "interrupted" } });
      });
    }
  }
  async function current(chatKey) {
    for (const jobId of controllers.keys()) {
      const job = await store.readJobState(jobId);
      if (job?.chatKey === chatKey && pending.has(jobId) && job.userQuestion?.state === "pending") {
        return { jobId, requesterUserId: job.requesterUserId, ...job.userQuestion };
      }
    }
    return null;
  }
  async function answer(params) {
    return locked(params.jobId, async () => {
      const job = await store.readJobState(params.jobId);
      const q = job?.userQuestion;
      if (!q || q.id !== params.questionId || job.chatKey !== params.chatKey
        || String(job.requesterUserId) !== String(params.userId)) throw new Error("Question identity mismatch");
      if (q.state !== "pending" || q.index !== params.index || !pending.has(job.id)) return { stale: true };
      if (params.cancel) {
        await store.writeJobState({ id: job.id, userQuestion: { ...q, state: "cancelled" } });
        controllers.get(job.id)?.abort(new Error("User cancelled questions"));
        return { cancelled: true };
      }
      const question = q.questions[q.index];
      const value = params.option != null ? question.options?.[params.option]?.label : params.text;
      if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new Error("Invalid answer");
      const answers = { ...q.answers, [question.id]: { answers: [value.trim()] } };
      const index = q.index + 1;
      const done = index === q.questions.length;
      await store.writeJobState({ id: job.id, userQuestion: { ...q, answers, index, state: done ? "answered" : "pending" } });
      if (done) pending.get(job.id).resolve({ answers });
      return { done, index, ...(done ? { answers } : {}) };
    });
  }
  return { ask, current, answer };
}
