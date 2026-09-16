import { b, code, escapeHtml } from "../telegram/html.js";
import { editOrReplyTelegramHtml } from "../telegram/api.js";
import { destinationKey, workspaceState } from "./store.js";
import { telegramMetaFromChatKey } from "../telegram/context.js";

export function createTaskDashboard(r, { accounts, text: t, now = Date.now }) {
  const state = workspaceState(r.state);
  let ticking = false;
  function activeFor(meta) {
    return [...r.activeTurns.entries()].filter(([key, a]) => {
      const p = a.currentPreparedTurn;
      return destinationKey(p || telegramMetaFromChatKey(key)) === destinationKey(meta);
    });
  }
  async function describe(meta) {
    const labels = new Map((await accounts.list()).map((a) => [a.id, a.label]));
    const turns = activeFor(meta);
    const lines = [b(t("dashboard")), ""];
    for (const [key, a] of turns.slice(0, 4)) {
      const chat = r.getChatState(key);
      const opts = r.getEffectiveOptions(key);
      const account = chat.accountAttemptState?.accountId || chat.threadAccountId || chat.accountId || "default";
      const elapsed = Math.max(0, Math.floor((now() - Date.parse(a.currentTurnStartedAt || new Date(now()).toISOString())) / 1000));
      lines.push(b((r.redactText?.(a.currentText || "") || a.currentText || t("running")).slice(0, 100)),
        `${t("account")}: ${escapeHtml(labels.get(account) || account)}`,
        `${t("folder")}: ${code(String(opts.workingDirectory || "").slice(0, 220))}`,
        `${t("model")}: ${code(String(opts.model || "default").slice(0, 100))} · ${code(opts.modelReasoningEffort || "default")}`,
        `${t("elapsed")}: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s · ${t("queue")}: ${r.getPendingTurns(key).length}`,
        code((r.redactText?.(a.lastProgress || "") || a.lastProgress || "").slice(0, 160)), "");
    }
    if (!turns.length) lines.push(t("idle"));
    return lines.join("\n");
  }
  async function cleanup(key, panel) {
    if (panel.pinned) await r.bot.telegram.unpinChatMessage(panel.chatId, panel.messageId).catch(() => {});
    await r.bot.telegram.deleteMessage(panel.chatId, panel.messageId).catch(() => {});
    delete state.panels[key];
    await r.saveState();
  }
  async function tick() {
    if (ticking || !r.bot.botInfo?.id) return;
    ticking = true;
    try {
      const destinations = new Map();
      for (const [, active] of r.activeTurns) {
        const meta = active.currentPreparedTurn;
        if (meta?.chatId) destinations.set(destinationKey(meta), meta);
      }
      for (const [key, panel] of Object.entries(state.panels)) {
        if (panel.botId !== r.bot.botInfo.id) { delete state.panels[key]; await r.saveState(); continue; }
        if (!destinations.has(key) || state.panelPreferences[key] === false) await cleanup(key, panel);
      }
      for (const [key, meta] of destinations) {
        if (state.panelPreferences[key] === false) continue;
        let panel = state.panels[key];
        let html = await describe(meta);
        const extra = { reply_markup: { inline_keyboard: [[
          { text: t("stop"), callback_data: "w:stop" }, { text: t("queue"), callback_data: "p:queue" }
        ], [{ text: t("tasks"), callback_data: "w:tasks" }, { text: t("dashboard"), callback_data: "w:dashboard" }],
        [{ text: t("close"), callback_data: "w:hide" }]] } };
        if (!panel) {
          const message = await r.replyHtml(r.createSyntheticCtx(meta), html, extra);
          panel = { botId: r.bot.botInfo.id, chatId: meta.chatId, messageThreadId: meta.messageThreadId, messageId: message.message_id, pinned: false };
          state.panels[key] = panel;
          await r.saveState();
          try { await r.bot.telegram.pinChatMessage(panel.chatId, panel.messageId, { disable_notification: true }); panel.pinned = true; }
          catch { panel.pinFailed = true; }
          await r.saveState();
        }
        if (panel.pinFailed) html += `\n${t("pinUnavailable")}`;
        if (panel.html === html) continue;
        try {
          await editOrReplyTelegramHtml({ editMessageText: (text, options) => r.bot.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, options) },
            html, extra, { replyOnUnavailable: false });
          panel.html = html;
        } catch (error) {
          if (/message to edit not found/i.test(error.message)) { delete state.panels[key]; await r.saveState(); }
        }
      }
    } finally { ticking = false; }
  }
  return { tick, describe, activeFor };
}
