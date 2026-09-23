import { DEFAULT_ACCOUNT_ID } from "./store.js";

export function reconcileAccountSelections(state, accounts, preferredId = DEFAULT_ACCOUNT_ID) {
  const available = new Set(accounts.map((account) => account.id));
  const fallback = available.has(preferredId) ? preferredId : accounts[0]?.id;
  if (!fallback) return;
  state.accountDefaultId = fallback;
  for (const chat of Object.values(state.chats || {})) {
    if (!available.has(chat.accountId || DEFAULT_ACCOUNT_ID)) chat.accountId = fallback;
    if (chat.threadId && !available.has(chat.threadAccountId || DEFAULT_ACCOUNT_ID)) {
      delete chat.threadId;
      delete chat.threadAccountId;
    }
    if (chat.accountThreads) {
      for (const id of Object.keys(chat.accountThreads)) {
        if (!available.has(id)) delete chat.accountThreads[id];
      }
    }
    if (chat.accountAttemptState && !available.has(chat.accountAttemptState.accountId)) delete chat.accountAttemptState;
  }
  for (const group of Object.values(state.forum?.groups || {})) {
    for (const topic of Object.values(group.topics || {})) {
      if (topic.preset?.accountId && !available.has(topic.preset.accountId)) topic.preset.accountId = fallback;
    }
  }
}
