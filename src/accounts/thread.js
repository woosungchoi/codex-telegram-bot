import { createAccountStore, DEFAULT_ACCOUNT_ID } from "./store.js";
import { accountConfig } from "./context.js";
import { classifyAccountFailure, codexEventError, hasAttemptActivity } from "./errors.js";
import { portableHistory, withAccountHandoff } from "./handoff.js";
import { applyCodexStreamEvent, codexStreamResult, createCodexStreamState } from "../codex/stream.js";

export function createAccountThread({ config, accountId = DEFAULT_ACCOUNT_ID, threadId = "", transport,
  createThread, attemptState = {}, store = createAccountStore(config), readHistory = portableHistory }) {
  const facade = {
    id: threadId,
    accountId,
    transport,
    ...threadContext(config, accountId),
    async run(input, options = {}) {
      const state = createCodexStreamState();
      const { events } = await this.runStreamed(input, options);
      for await (const event of events) applyCodexStreamEvent(state, event);
      return codexStreamResult(state);
    },
    async runStreamed(input, options = {}) {
      return { events: runAttempts(input, options) };
    }
  };
  async function* runAttempts(input, options) {
    const originAccountId = facade.accountId;
    const originThreadId = facade.id;
    const originConfig = accountConfig(config, originAccountId);
    const tried = new Set(attemptState.triedAccountIds || []);
    const candidates = await store.candidates();
    const targets = [originAccountId, ...candidates.map((a) => a.id).filter((id) => id !== originAccountId)];
    let lastError;
    const failures = [];
    let history;
    for (const id of targets) {
      options.signal?.throwIfAborted();
      if (tried.has(id)) continue;
      tried.add(id);
      let release;
      let activity = false;
      let failure;
      let completed = false;
      try {
        release = await store.acquire(id);
        const scoped = accountConfig(config, id);
        facade.accountId = id;
        Object.assign(facade, threadContext(config, id));
        if (id !== originAccountId) facade.id = "";
        yield { type: "account.attempt.started", accountId: id, threadId: facade.id, triedAccountIds: [...tried], hadActivity: id === originAccountId && attemptState.hadActivity === true };
        if (id !== originAccountId) {
          yield { type: "account.rotation", fromAccountId: originAccountId, accountId: id, accountLabel: (await store.get(id)).label };
          history ??= await readHistory(originConfig.codexSessionsDir, originThreadId);
        }
        options.signal?.throwIfAborted();
        const thread = createThread(scoped, facade.id);
        const { events } = await thread.runStreamed(id === originAccountId ? input : withAccountHandoff(input, history), options);
        for await (const event of events) {
          if (hasAttemptActivity(event)) activity = true;
          const error = codexEventError(event);
          if (error && !error.willRetry) { failure = error; continue; }
          if (event.type === "thread.started") facade.id = event.thread_id;
          if (event.method === "thread/started") facade.id = event.params?.thread?.id || facade.id;
          if (event.type === "turn.completed" || (event.method === "turn/completed" && event.params?.turn?.status === "completed")) completed = true;
          yield { ...event, accountId: id };
        }
        // Exhaust the iterator before considering another account. The SDK's
        // finally block waits for the old CLI to exit, releasing its tools.
        options.signal?.throwIfAborted();
        if (failure) throw failure;
        if (!completed) throw new Error("Codex stream ended without a completed turn.");
        await store.markSuccess(id);
        yield { type: "account.selected", fromAccountId: originAccountId, accountId: id };
        return;
      } catch (error) {
        lastError = failure || error;
        if (options.signal?.aborted) throw error;
        const reason = classifyAccountFailure(lastError);
        if (!reason) throw lastError;
        failures.push(`${(await store.get(id)).label}: ${reason.kind}`);
        await store.markFailure(id, reason);
        if (activity || attemptState.hadActivity) throw lastError;
      } finally {
        await release?.();
      }
    }
    if (lastError && failures.length > 1) lastError.message += `\nAccount rotation exhausted (${failures.length}): ${failures.join("; ")}`;
    throw lastError || new Error("No eligible accounts remain for this task. Open /accounts.");
  }
  return facade;
}

function threadContext(config, id) {
  const scoped = accountConfig(config, id);
  return { codexEnv: scoped.codexEnv, sessionsDir: scoped.codexSessionsDir, codexAuthFileStore: scoped.codexAuthFileStore };
}
