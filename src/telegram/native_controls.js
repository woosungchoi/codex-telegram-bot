import { createHash } from "node:crypto";
import { splitText } from "./split.js";
const token = (id) => createHash("sha256").update(id).digest("hex").slice(0, 20);
export function nativeControlsKeyboard(jobId, text) {
  return { reply_markup: { inline_keyboard: [[
    { text: text("nativeInspect"), callback_data: `native:inspect:${token(jobId)}` },
    { text: text("nativeFiles"), callback_data: `native:files:${token(jobId)}` },
    { text: text("nativeResult"), callback_data: `native:result:${token(jobId)}` }
  ]] } };
}
// A panel's control identity exists before worker admission and survives worker retries.
export function panelControlsKeyboard(runId, text) {
  const extra = nativeControlsKeyboard(runId, text);
  for (const button of extra.reply_markup.inline_keyboard[0]) button.callback_data = button.callback_data.replace("native:", "panel:");
  return extra;
}
export function createNativeControls({ getClient, getChatKey, activeTurns, deliveries, queue, steering, text, refreshStatus, resolveStatusJob }) {
  const busy = new Set();
  function jobs(key) {
    return [...new Set([activeTurns.get(key)?.workerJobId,
      ...Object.values(deliveries()).filter((d) => d.chatKey === key).reverse().map((d) => d.jobId)].filter(Boolean))].slice(0, 40);
  }
  async function handlePanel(ctx, action, hash) {
    const key = getChatKey(ctx);
    if (busy.has(key)) { await ctx.answerCbQuery(); return; }
    busy.add(key);
    let answered = false;
    const answer = async (message) => { answered = true; await ctx.answerCbQuery(message); };
    try {
      const run = await resolveStatusJob?.(ctx, hash);
      if (!run?.requesterUserId || String(ctx.from?.id) !== String(run.requesterUserId)) { await answer(text("panelUnavailable")); return; }
      if (action === "back") {
        await answer();
        await refreshStatus?.(ctx, { ...run, panelRunId: run.id }, "back");
        return;
      }
      if (!run.jobId) { await answer(text("panelPreparing")); return; }
      let view;
      try { view = await getClient().inspectJob({ jobId: run.jobId, chatKey: run.chatKey, userId: String(ctx.from.id), remote: action !== "files" }); }
      catch { await answer(text("nativeUnavailable")); return; }
      if (!view) { await answer(text("panelUnavailable")); return; }
      if (action === "result" && !view.result) { await answer(text("nativeNoResult")); return; }
      await answer();
      await refreshStatus?.(ctx, { ...view, chatKey: run.chatKey, panelRunId: run.id }, action);
    } catch {
      if (!answered) await answer(text("nativeUnavailable"));
    } finally { busy.delete(key); }
  }
  async function handle(ctx, next = () => {}) {
    const panel = /^panel:(inspect|files|result|back):([a-f0-9]{20})$/.exec(ctx.callbackQuery?.data || "");
    if (panel) return handlePanel(ctx, panel[1], panel[2]);
    const match = /^native:(inspect|files|result|diff):([a-f0-9]{20})$/.exec(ctx.callbackQuery?.data || "");
    const command = /^\/(progress|recovery)(?:@\w+)?(?:\s|$)/i.exec(ctx.message?.text || "");
    if (!match && !command) return next();
    if (match && ["inspect", "files", "result"].includes(match[1]) && (await resolveStatusJob?.(ctx, match[2]))?.id) {
      return handlePanel(ctx, match[1], match[2]);
    }
    if (match) await ctx.answerCbQuery();
    const key = getChatKey(ctx);
    if (busy.has(key)) return;
    busy.add(key);
    try {
      if (command?.[1].toLowerCase() === "recovery") await steering.reconcile?.(key);
      let ids = jobs(key);
      if (match) ids = ids.filter((id) => token(id) === match[2]);
      const scoped = match && await resolveStatusJob?.(ctx, match[2]);
      if (scoped) ids = [scoped.jobId];
      const inspectionKey = scoped?.chatKey || key;
      let view;
      for (const jobId of ids) {
        try { view = await getClient().inspectJob({ jobId, chatKey: inspectionKey, userId: String(ctx.from?.id || ""), remote: match?.[1] === "inspect" || match?.[1] === "result" || command?.[1].toLowerCase() === "recovery" }); }
        catch { continue; }
        if (view) break;
      }
      if (!view) {
        const pending = queue(key).filter((t) => String(t.requesterUserId) === String(ctx.from?.id));
        const unsent = pending.filter((t) => !t.steering).length;
        const held = pending.length - unsent;
        await ctx.reply(pending.length ? `${text("nativeReceipt_unsent")}: ${unsent}\n${text("nativeHeld")}: ${held}` : text("nativeNoJob"));
        return;
      }
      const action = match?.[1];
      if (action === "inspect" && await refreshStatus?.(ctx, { ...view, chatKey: inspectionKey })) return;
      if (action === "result") {
        if (!view.result) { await ctx.reply(text("nativeNoResult"), nativeControlsKeyboard(view.jobId, text)); return; }
        for (const chunk of splitText(view.result, 3500)) await ctx.reply(chunk);
        return;
      }
      if (action === "diff" && view.progress.diff) {
        // Send bounded plain text as a document to avoid HTML parsing and flooding.
        await ctx.replyWithDocument({ source: Buffer.from(view.progress.diff), filename: "changes.diff" }, { caption: text(view.progress.diffTruncated ? "nativeDiffTruncated" : "nativeFiles") });
        return;
      }
      const lines = [text("nativeProgress"), `${text("nativeReceipt")}: ${text(`nativeReceipt_${view.receipt}`)}`,
        `${text("nativeState")}: ${text(`nativeState_${view.nativeStatus || view.status}`)}`];
      if (view.inspectionUnavailable) lines.push(text("nativeUnavailable"));
      if (action === "files") lines.push(...(view.progress.files || []).slice(0, 60));
      else {
        for (const step of (view.progress.plan || []).slice(0, 12)) lines.push(`${step.status === "completed" ? "✅" : step.status === "inProgress" ? "▶️" : "▫️"} ${step.step}`);
        const held = queue(key).filter((t) => t.steering && String(t.requesterUserId) === String(ctx.from?.id)).length;
        if (held) lines.push(`${text("nativeHeld")}: ${held}`);
      }
      const keyboard = nativeControlsKeyboard(view.jobId, text);
      if (view.progress.diff) keyboard.reply_markup.inline_keyboard.push([{ text: text("nativeDiff"), callback_data: `native:diff:${token(view.jobId)}` }]);
      await ctx.reply(lines.join("\n").slice(0, 3800), keyboard);
    } finally { busy.delete(key); }
  }
  return { handle };
}
