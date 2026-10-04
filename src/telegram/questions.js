// One question at a time. All callback identity/cursor checks happen again in
// the worker; this presentation cache is disposable across frontend restarts.
export function createQuestionUi({ getClient, getChatKey, text }) {
  const shown = new Map();
  const busy = new Set();
  async function show(ctx, question) {
    if (!question) return;
    const key = getChatKey(ctx);
    const version = `${question.id}:${question.index}`;
    if (shown.get(key)?.version === version) return;
    const q = question.questions[question.index];
    if (!q) return;
    const rows = (q.options || []).map((option, index) => [{
      text: `${String.fromCharCode(65 + index)}. ${option.label}`.slice(0, 100),
      callback_data: `ask:${question.id}:${question.index}:${index}`
    }]);
    rows.push([{ text: text("questionsType"), callback_data: `ask:${question.id}:${question.index}:text` },
      { text: text("questionsCancel"), callback_data: `ask:${question.id}:${question.index}:cancel` }]);
    const descriptions = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}: ${o.description || ""}`).join("\n");
    const body = `${text("questionsTitle")} ${question.index + 1}/${question.questions.length}\n\n${q.question}\n\n${descriptions}\n\n${text("questionsWaiting")}`;
    const sent = await ctx.reply(body.slice(0, 4000), { reply_markup: { inline_keyboard: rows } });
    shown.set(key, { version, messageId: sent.message_id });
  }
  async function poll(ctx) {
    const key = getChatKey(ctx);
    if (busy.has(key)) return;
    busy.add(key);
    try { await show(ctx, await getClient().currentQuestion(key)); }
    finally { busy.delete(key); }
  }
  async function handle(ctx, next) {
    const callback = ctx.callbackQuery?.data;
    const match = /^ask:([a-f0-9]{32}):(\d+):(\d+|text|cancel)$/.exec(callback || "");
    if (callback && !match) return next();
    if (!match && (!ctx.message?.text || ctx.message.text.startsWith("/"))) return next();
    const key = getChatKey(ctx);
    let q;
    try { q = await getClient().currentQuestion(key); }
    catch (error) { if (match) throw error; return next(); }
    if (!q && !match) return next();
    const valid = q && String(ctx.from?.id) === String(q.requesterUserId)
      && (!match || (q.id === match[1] && q.index === Number(match[2])));
    if (!valid) {
      if (match) await ctx.answerCbQuery(text("questionsStale"));
      else await ctx.reply(text("questionsOwner"));
      return;
    }
    if (match) await ctx.answerCbQuery();
    if (match?.[3] === "text") {
      const prompt = await ctx.reply(text("questionsReply"), { reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: ctx.callbackQuery.message.message_id } });
      const previous = shown.get(key) || { version: `${q.id}:${q.index}`, messageId: ctx.callbackQuery.message.message_id };
      shown.set(key, { ...previous, inputMessageId: prompt.message_id });
      return;
    }
    if (busy.has(key)) return;
    busy.add(key);
    try {
      let option = match && /^\d+$/.test(match[3]) ? Number(match[3]) : null;
      let answer = ctx.message?.text;
      if (!match) {
        const index = /^[A-T]$/i.test(answer.trim()) ? answer.trim().toUpperCase().charCodeAt(0) - 65
          : /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1;
        if (index >= 0 && index < (q.questions[q.index].options?.length || 0)) option = index;
        else if (![shown.get(key)?.messageId, shown.get(key)?.inputMessageId].filter(Boolean).includes(ctx.message.reply_to_message?.message_id)) {
          await ctx.reply(text("questionsReply"));
          return;
        }
      }
      const result = await getClient().answerQuestion({ jobId: q.jobId, questionId: q.id,
        index: q.index, chatKey: key, userId: String(ctx.from.id), option,
        text: answer, cancel: match?.[3] === "cancel" });
      if (result.stale) { await ctx.reply(text("questionsStale")); return; }
      const messageId = ctx.callbackQuery?.message?.message_id || shown.get(key)?.messageId;
      if (messageId) await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, messageId, undefined, { inline_keyboard: [] }).catch(() => {});
      shown.delete(key);
      if (result.done || result.cancelled) {
        const summary = result.done ? Object.entries(result.answers || {}).map(([id, value]) => `${id}: ${value.answers.join(", ")}`).join("\n") : "";
        await ctx.reply(`${text(result.done ? "questionsDone" : "questionsCancelled")}\n${summary}`.slice(0, 4000));
      }
      else await show(ctx, await getClient().currentQuestion(key));
    } finally { busy.delete(key); }
  }
  return { poll, handle };
}
