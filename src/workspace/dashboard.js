import { b, code, escapeHtml } from "../telegram/html.js";
import { editOrReplyTelegramHtml } from "../telegram/api.js";
import { nativeControlsKeyboard, panelControlsKeyboard } from "../telegram/native_controls.js";
import { progressTurnId } from "../telegram/progress_store.js";
import { textFor } from "../i18n.js";
import { destinationKey, workspaceState } from "./store.js";
import { telegramContextMeta, telegramMetaFromChatKey } from "../telegram/context.js";

export function createTaskDashboard(r, { accounts, text: t, now = Date.now }) {
  const state = workspaceState(r.state);
  const label = (key) => textFor(r.state.ui?.language || r.config.telegramLanguage, key);
  const safe = (value, size) => String(r.redactText?.(String(value || "")) ?? value ?? "").slice(0, size);
  let pending = Promise.resolve();
  let lastProgressAt = 0;
  function activeFor(meta) {
    return [...r.activeTurns.entries()].filter(([key, a]) => {
      const p = a.currentPreparedTurn;
      return destinationKey(p || telegramMetaFromChatKey(key)) === destinationKey(meta);
    });
  }
  function runId(key, a) {
    return `${key}:${progressTurnId(a.currentPreparedTurn) || a.currentTurnStartedAt || "active"}`;
  }
  function snapshot(key, a, labels) {
    const chat = r.getChatState(key);
    const opts = r.getEffectiveOptions(key);
    const account = chat.accountAttemptState?.accountId || chat.threadAccountId || chat.accountId || "default";
    const elapsed = Math.max(0, Math.floor((now() - Date.parse(a.currentTurnStartedAt || new Date(now()).toISOString())) / 1000));
    const p = a.nativeProgress || {};
    const result = a.dashboardResult;
    const submitted = !!a.workerJobId;
    const inspection = a.dashboardInspection?.jobId === a.workerJobId ? a.dashboardInspection : null;
    const observed = submitted && a.workerInputReceipt?.jobId === a.workerJobId ? a.workerInputReceipt.receipt : null;
    const confirmed = [inspection?.receipt, observed].find((value) => value === "recovered")
      || [inspection?.receipt, observed].find((value) => value === "accepted");
    const status = result ? result.cancelled ? "interrupted" : result.delivered || result.deliveryPending ? "completed" : "failed"
      : p.activeFlags?.includes("waitingOnApproval") ? "waiting" : !submitted && !p.status ? "preparing" : p.status === "idle" ? "active" : p.status || "active";
    const lines = [b(safe(a.currentText || t("running"), 90)),
      `${t("account")}: ${escapeHtml(safe(labels.get(account) || account, 80))}`,
      `${t("folder")}: ${code(safe(opts.workingDirectory, 180))}`,
      `${t("model")}: ${code(safe(opts.model || "default", 70))} · ${code(opts.modelReasoningEffort || "default")}`,
      `${t("elapsed")}: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s · ${t("queue")}: ${r.getPendingTurns(key).length}`];
    for (const step of (p.plan || []).slice(0, 4)) lines.push(`${step.status === "completed" ? "✅" : step.status === "inProgress" ? "▶️" : "▫️"} ${escapeHtml(safe(step.step, 110))}`);
    if (p.files?.length) lines.push(`${label("nativeFiles")}: ${code(safe(p.files.slice(0, 3).join(", "), 160))}`);
    if (p.tokenUsage?.last) lines.push(`${label("nativeTokens")}: ${p.tokenUsage.last.inputTokens ?? 0} / ${p.tokenUsage.last.outputTokens ?? 0} · ${label("nativeWindow")}: ${p.tokenUsage.modelContextWindow ?? "—"}`);
    if (a.lastProgress) lines.push(code(safe(a.lastProgress, 120)));
    return { id: runId(key, a), requesterUserId: String(a.currentPreparedTurn?.requesterUserId || ""), chatKey: key, jobId: a.workerJobId || "", status,
      receipt: confirmed || inspection?.receipt || observed || (submitted ? "not_checked" : "unsent"), inspectionUnavailable: !confirmed && inspection?.unavailable === true,
      finished: !!result, delivery: result?.delivered ? "delivery_sent" : result?.deliveryPending ? "delivery_failed" : result ? "not_sent" : "streaming",
      body: lines.join("\n") };
  }
  function refreshDelivery(run) {
    const receipt = run.jobId && r.state.worker?.deliveries?.[`${run.chatKey}:${run.jobId}`];
    if (receipt?.deliveryStatus) run.delivery = receipt.deliveryStatus;
    if (run.finished && run.delivery === "streaming") run.delivery = "legacy_unknown";
    return run;
  }
  function render(runs) {
    return [b(t("dashboard")), ...runs.slice(0, 2).map((run) => [run.body,
      `${label("nativeReceipt")}: ${label(`nativeReceipt_${run.receipt || "uncertain"}`)}`,
      ...(run.inspectionUnavailable ? [label("nativeUnavailable")] : []),
      `${label("nativeState")}: ${label(`nativeState_${run.status}`)}`,
      `${label("dashboardDelivery")}: ${label(`dashboardDelivery_${run.delivery}`)}`].join("\n"))].join("\n\n");
  }
  async function describe(meta) {
    const labels = new Map((await accounts.list()).map((a) => [a.id, a.label]));
    const runs = activeFor(meta).slice(0, 2).map(([key, a]) => refreshDelivery(snapshot(key, a, labels)));
    return runs.length ? render(runs) : `${b(t("dashboard"))}\n${t("idle")}`;
  }
  function keyboard(runs, running, detail = null) {
    const rows = [];
    for (const run of runs.slice(0, 2)) rows.push(...panelControlsKeyboard(run.id, label).reply_markup.inline_keyboard);
    if (detail) rows.push([{ text: t("back"), callback_data: panelControlsKeyboard(detail.runId, label).reply_markup.inline_keyboard[0][0].callback_data.replace(":inspect:", ":back:") }]);
    if (running) rows.push([{ text: t("stop"), callback_data: "w:stop" }, { text: t("queue"), callback_data: "p:queue" }]);
    rows.push([{ text: t("tasks"), callback_data: "w:tasks" }, { text: t("dashboard"), callback_data: "w:dashboard" }]);
    if (running) rows.push([{ text: t("close"), callback_data: "w:hide" }]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  async function unpin(panel) {
    if (!panel.pinned) return;
    await r.bot.telegram.unpinChatMessage(panel.chatId, panel.messageId);
    panel.pinned = false;
  }
  async function cleanup(key, panel) {
    // Persist before Telegram I/O; a timeout must not lose the only message reference.
    panel.cleanupPending = true;
    await r.saveState();
    await unpin(panel).catch(() => {});
    try { await r.bot.telegram.deleteMessage(panel.chatId, panel.messageId); }
    catch (error) {
      if (!/message to delete not found/i.test(error.message)) { await r.saveState(); return false; }
    }
    if (state.panels[key] === panel) delete state.panels[key];
    await r.saveState();
    return true;
  }
  const delivered = (runs) => runs.length > 0 && runs.every((run) => run.delivery === "delivery_sent");
  async function updatePanel(key, panel, runs, running) {
    if (delivered(runs)) {
      panel.runs = runs;
      panel.finished = !running;
      return cleanup(key, panel);
    }
    if (!running || !runs.some((run) => run.id === panel.detail?.runId && run.jobId === panel.detail?.jobId)) delete panel.detail;
    const html = (panel.detail ? `${b(t("dashboard"))}\n\n${panel.detail.html}` : render(runs)) + (panel.pinFailed && running ? `\n${t("pinUnavailable")}` : "");
    const extra = keyboard(runs, running, panel.detail);
    const markup = JSON.stringify(extra);
    if (panel.html === html && panel.markup === markup && panel.finished === !running
      && JSON.stringify(panel.runs) === JSON.stringify(runs) && (running || !panel.pinned)) return;
    if (panel.html !== html || panel.markup !== markup) {
      await editOrReplyTelegramHtml({ editMessageText: (text, options) => r.bot.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, options) }, html, extra, { replyOnUnavailable: false });
      panel.html = html;
      panel.markup = markup;
    }
    panel.runs = runs;
    panel.finished = !running;
    if (!running) await unpin(panel);
    await r.saveState();
  }
  async function runTick() {
    if (!r.bot.botInfo?.id) return;
    const destinations = new Map();
    for (const [, active] of r.activeTurns) {
      const meta = active.currentPreparedTurn;
      if (meta?.chatId) destinations.set(destinationKey(meta), meta);
    }
    for (const [key, panel] of Object.entries(state.panels)) {
      if (panel.botId !== r.bot.botInfo.id) { delete state.panels[key]; await r.saveState(); continue; }
      if (panel.cleanupPending || state.panelPreferences[key] === false) { await cleanup(key, panel); continue; }
      if (!destinations.has(key)) {
        // Preserve the last card, including a pending/ambiguous final delivery.
        // Absence from activeTurns after a restart is not proof of success.
        if (!panel.runs) { await cleanup(key, panel); continue; }
        const runs = panel.runs.map((run) => refreshDelivery({ ...run, finished: true,
          status: run.finished || ["completed", "failed", "interrupted"].includes(run.status) ? run.status : "unknown" }));
        await updatePanel(key, panel, runs, false).catch(() => {});
      }
    }
    if (!destinations.size) return;
    const labels = new Map((await accounts.list()).map((a) => [a.id, a.label]));
    for (const [key, meta] of destinations) {
      if (state.panelPreferences[key] === false) continue;
      const all = activeFor(meta);
      const running = all.some(([, a]) => !a.dashboardResult);
      const runs = all.map(([chatKey, a]) => refreshDelivery(snapshot(chatKey, a, labels)));
      let panel = state.panels[key];
      if (panel?.cleanupPending) continue;
      if (delivered(runs)) {
        if (panel) await cleanup(key, panel);
        continue; // The turn may remain in activeTurns until its finally block returns.
      }
      if (!panel) {
        const message = await r.replyHtml(r.createSyntheticCtx(meta), render(runs), keyboard(runs, running));
        panel = { botId: r.bot.botInfo.id, chatId: meta.chatId, messageThreadId: meta.messageThreadId, messageId: message.message_id, pinned: false, runs };
        state.panels[key] = panel;
        await r.saveState();
      }
      if (running && !panel.pinned && !panel.pinFailed) {
        try { await r.bot.telegram.pinChatMessage(panel.chatId, panel.messageId, { disable_notification: true }); panel.pinned = true; }
        catch { panel.pinFailed = true; }
        await r.saveState();
      }
      try { await updatePanel(key, panel, runs, running); }
      catch (error) {
        if (/message to edit not found/i.test(error.message)) { delete state.panels[key]; await r.saveState(); }
      }
    }
  }
  function tick() {
    // Serialize timer, event and completion updates: an old edit must never win.
    const work = pending.then(runTick);
    pending = work.catch(() => {});
    return work;
  }
  async function updateProgress(_state, event) {
    const urgent = ["turn.completed", "turn.failed", "turn.interrupted", "thread.status"].includes(event.type);
    if (!urgent && now() - lastProgressAt < 3000) return;
    lastProgressAt = now();
    await tick();
  }
  async function recordResult(key, prepared, result) {
    const active = r.activeTurns.get(key);
    if (!active || destinationKey(active.currentPreparedTurn) !== destinationKey(prepared)) return;
    active.dashboardResult = result;
    await tick();
  }
  function callbackPanel(ctx) {
    const panel = state.panels[destinationKey(telegramContextMeta(ctx))];
    return panel?.botId === r.bot.botInfo.id && panel.messageId === ctx.callbackQuery?.message?.message_id ? panel : null;
  }
  function resolveJob(ctx, token) {
    const panel = callbackPanel(ctx);
    if (panel?.cleanupPending) return undefined;
    const run = panel?.runs?.find((run) =>
      panelControlsKeyboard(run.id, label).reply_markup.inline_keyboard[0][0].callback_data.endsWith(`:${token}`)
      || (run.jobId && nativeControlsKeyboard(run.jobId, label).reply_markup.inline_keyboard[0][0].callback_data.endsWith(`:${token}`)));
    if (!run) return undefined;
    const active = r.activeTurns.get(run.chatKey);
    // Receipt may arrive before the next render; never send an invented job ID to the worker.
    return active && runId(run.chatKey, active) === run.id
      ? { ...run, jobId: active.workerJobId || "", requesterUserId: String(active.currentPreparedTurn?.requesterUserId || run.requesterUserId || "") } : run;
  }
  async function refresh(ctx, view, action = "inspect") {
    // Serialize callback edits with completion/deletion. A late RPC cannot resurrect a card.
    const work = pending.then(async () => {
      const panel = callbackPanel(ctx);
      const run = panel?.runs?.find((run) => run.chatKey === view.chatKey && (view.panelRunId ? run.id === view.panelRunId : run.jobId === view.jobId));
      if (!run || panel.cleanupPending) return false;
      if (view.panelRunId && (!run.requesterUserId || String(ctx.from?.id) !== run.requesterUserId)) return false;
      const active = r.activeTurns.get(view.chatKey);
      if (view.receipt) {
        run.receipt = view.receipt;
        run.inspectionUnavailable = view.inspectionUnavailable === true;
        if (active?.workerJobId === view.jobId) active.dashboardInspection = { jobId: view.jobId, receipt: view.receipt, unavailable: run.inspectionUnavailable };
      }
      if (active?.workerJobId === view.jobId && !active.dashboardResult && view.progress) active.nativeProgress = { ...view.progress, status: view.nativeStatus || view.progress.status };
      if (action === "files" || action === "result") {
        const content = action === "files" ? (view.progress?.files || []).join("\n") || label("panelNoFiles") : view.result;
        panel.detail = { runId: run.id, jobId: view.jobId, html: `${b(label(action === "files" ? "nativeFiles" : "nativeResult"))}\n${escapeHtml(safe(content, 2800))}${String(content || "").length > 2800 ? `\n${label("panelPreviewLimited")}` : ""}` };
      } else delete panel.detail;
      await r.saveState();
      await runTick();
      return true;
    });
    pending = work.catch(() => {});
    return work;
  }
  return { tick, describe, activeFor, updateProgress, recordResult, refresh, resolveJob };
}
