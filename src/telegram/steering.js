export function createSteeringUi({ getClient, getChatKey, queue, text, admissionPaused = () => false }) {
  const busy = new Set();
  function keyboard(turn) {
    return turn.steerTarget ? { reply_markup: { inline_keyboard: [[{
      text: text("steerButton"), callback_data: `steer:${turn.id}`
    }]] } } : undefined;
  }
  async function handle(ctx, next) {
    const match = /^steer:([a-zA-Z0-9_-]{1,55})$/.exec(ctx.callbackQuery?.data || "");
    if (!match) return next();
    await ctx.answerCbQuery();
    const key = getChatKey(ctx);
    if (busy.has(key)) return;
    busy.add(key);
    try {
      const turn = queue.get(key).find((t) => t.id === match[1]);
      if (!turn?.steerTarget || !turn.requesterUserId || String(turn.requesterUserId) !== String(ctx.from?.id)) {
        await ctx.reply(text("steerStale")); return;
      }
      if (admissionPaused() || await getClient().currentQuestion(key)) {
        await ctx.reply(text("steerWaiting")); return;
      }
      if (!queue.get(key).includes(turn)) { await ctx.reply(text("steerStale")); return; }
      // Set before the first await: queue dequeue cannot race this claim. The
      // serialized marker also holds this item across frontend/worker restart.
      turn.steering = { jobId: turn.steerTarget, status: "sending" };
      await queue.persist(key);
      let result;
      try {
        result = await getClient().steerJob({ jobId: turn.steerTarget, requestId: turn.id,
          chatKey: key, userId: String(ctx.from.id), inputText: turn.inputText, imagePaths: turn.imagePaths });
      } catch { result = { status: "unknown" }; }
      if (result.status === "accepted") await queue.remove(key, turn.id);
      else if (result.status === "rejected") { delete turn.steering; await queue.persist(key); }
      else { turn.steering.status = "unknown"; await queue.persist(key); }
      if (result.status !== "unknown") await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      await ctx.reply(text(result.status === "accepted" ? "steerAccepted" : result.status === "rejected" ? "steerRejected" : "steerUnknown"));
      await queue.startDrain(key);
    } finally { busy.delete(key); }
  }
  return { keyboard, handle };
}
