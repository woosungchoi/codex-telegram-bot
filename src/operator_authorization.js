import { authorizeStoredRequest, requestProvenance } from "./authorization.js";

export function operatorAuthorized(ctx, config) {
  const id = String(ctx?.from?.id || "");
  return ctx?.chat?.type === "private" && String(ctx.chat.id) === id
    && (config.operatorUserIds ?? config.codexUpdateAdminUserIds)?.has(id) === true
    && config.allowedUserIds?.has(id) === true;
}
export function requireOperator(ctx, config) {
  if (!operatorAuthorized(ctx, config)) throw new Error("This operation requires an authorized operator in their private chat.");
  const record = { ...requestProvenance(ctx), chatId: String(ctx.chat.id),
    messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id };
  if (!authorizeStoredRequest(record, config)) throw new Error("Operator request provenance is incomplete or revoked.");
  return record;
}
export function verifyOperator(ctx, config, record) {
  const current = requireOperator(ctx, config);
  for (const key of ["authorizationVersion", "botId", "requesterUserId", "chatId", "chatType", "messageThreadId", "accountId", "isForum"]) {
    if (!record || current[key] !== record[key]) throw new Error("Operator approval does not belong to this request.");
  }
}
export function requireQueueOwner(ctx, config, records = [], { sharedPolicy = false } = {}) {
  if (config.queueAdminUserIds?.has(String(ctx.from?.id)) === true && authorizeStoredRequest({ ...requestProvenance(ctx), chatId: String(ctx.chat?.id), messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id }, config)) return;
  if (operatorAuthorized(ctx, config)) return;
  const id = String(ctx.from?.id || "");
  if (!id || (sharedPolicy && ctx.chat?.type !== "private") || records.some((record) =>
    !record || String(record.requesterUserId || "") !== id || !authorizeStoredRequest(record, config))) {
    throw new Error("Queue control requires the current request owner or an operator.");
  }
}

export function operatorContext(record) {
  return { botInfo: { id: record?.botId }, from: { id: record?.requesterUserId },
    chat: { id: record?.chatId, type: record?.chatType, is_forum: record?.isForum },
    message: { message_thread_id: record?.messageThreadId } };
}

const confirmations = new WeakMap();
const confirmationKey = (ctx, action) => JSON.stringify([ctx.botInfo?.id, ctx.from?.id, ctx.chat?.id,
  ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id, action]);
const targetDigest = (records) => JSON.stringify(records.map((item) => [item.id, item.requesterUserId, item.botId, item.accountId]));
export function rememberControlConfirmation(state, ctx, action, records = []) {
  let approvals = confirmations.get(state);
  if (!approvals) { approvals = new Map(); confirmations.set(state, approvals); }
  for (const [key, value] of approvals) if (value.until < Date.now()) approvals.delete(key);
  approvals.set(confirmationKey(ctx, action), { until: Date.now() + 300000, targets: targetDigest(records) });
}
export function consumeControlConfirmation(state, ctx, action, records = []) {
  const approvals = confirmations.get(state), key = confirmationKey(ctx, action), approval = approvals?.get(key);
  approvals?.delete(key);
  if (!approval || approval.until < Date.now() || approval.targets !== targetDigest(records)) throw new Error("Control confirmation expired or targets changed; request a fresh preview.");
}
