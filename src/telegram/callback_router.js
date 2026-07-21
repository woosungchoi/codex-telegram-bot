import { b, code } from "./html.js";

export function registerCallbackRoutes({
  bot,
  settings,
  state,
  threadCache,
  pendingTurns,
  usageRefreshes,
  cleanup,
  queue,
  selection,
  panels,
  callbacks,
  skills,
  commands,
  chats,
  usage,
  status,
  telegram,
  keyboards,
  localization,
  persistence,
  timing,
  now = Date.now
}) {
  bot.action(/^cleanup:(quarantine|delete|both|ignore):([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const [, action, planId] = ctx.match;
    const plan = state.cleanup?.plans?.[planId];
    if (!plan) {
      await cleanup.answerCallback(ctx, "missing");
      await cleanup.editMessage(
        ctx,
        `${b(localization.text("cleanupPlanNotFoundTitle"))}\n${localization.text("cleanupPlanNotFoundBody")}\n\n${localization.text("cleanupFreshCandidatesPrompt")} ${code("/cleanup")}.`
      );
      return;
    }
    if (now() > Date.parse(plan.expiresAt)) {
      await cleanup.answerCallback(ctx, "expired");
      delete state.cleanup.plans[planId];
      await persistence.save();
      await cleanup.editMessage(
        ctx,
        `${b(localization.text("cleanupPlanExpiredTitle"))}\n${localization.text("cleanupApprovalExpired")}: ${code(cleanup.formatDateTime(plan.expiresAt))}\n\n${localization.text("cleanupFreshCandidatesPrompt")} ${code("/cleanup")}.`
      );
      return;
    }
    await cleanup.answerCallback(ctx, action);
    await cleanup.editProcessingMessage(ctx, action, plan);
    if (action === "ignore") {
      delete state.cleanup.plans[planId];
      await persistence.save();
      await cleanup.editMessage(ctx, cleanup.formatIgnored(plan));
      return;
    }
    const result = await cleanup.applyPlan(plan, action);
    delete state.cleanup.plans[planId];
    await cleanup.appendLog({
      type: "apply",
      action,
      planId,
      result,
      at: new Date(now()).toISOString()
    });
    await persistence.save();
    await cleanup.editMessage(ctx, cleanup.formatResult(action, result, plan));
  });

  bot.action(/^upload_cleanup_confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const [, planId] = ctx.match;
    const record = state.uploadCleanup?.plans?.[planId];
    const confirmation = cleanup.confirmUploadPlan(record);
    if (!confirmation.ok) {
      await cleanup.answerUploadCallback(ctx, confirmation.reason);
      if (confirmation.reason === "expired_plan" && state.uploadCleanup?.plans) {
        delete state.uploadCleanup.plans[planId];
        await persistence.save();
      }
      await cleanup.editUploadMessage(
        ctx,
        `${b("Upload cleanup plan unavailable")}\nRun ${code("/cleanup_uploads")} to generate a fresh preview.`
      );
      return;
    }
    await cleanup.answerUploadCallback(ctx, "confirm");
    await telegram.editOrReplyHtml(
      ctx,
      cleanup.formatUploadProcessing(record),
      keyboards.inline([[{
        text: "Processing",
        callback_data: `upload_cleanup_processing:${planId}`
      }]])
    );
    const result = await cleanup.deleteUploadCandidates(
      confirmation.plan.candidates,
      { dryRun: false, rootDir: settings.config.uploadDir }
    );
    delete state.uploadCleanup.plans[planId];
    await cleanup.appendLog(cleanup.createUploadResultLogEntry(
      planId,
      confirmation.plan,
      result
    ));
    await persistence.save();
    await cleanup.editUploadMessage(
      ctx,
      cleanup.formatUploadResult(confirmation.plan, result)
    );
  });

  bot.action(/^upload_cleanup_processing:([a-zA-Z0-9_-]+)$/, (ctx) => (
    cleanup.answerUploadCallback(ctx, "processing")
  ));
  bot.action(/^cleanup:processing:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery(localization.text("cleanupAlreadyProcessing"));
    } catch (error) {
      console.warn("cleanup processing callback answer failed:", telegram.summarizeError(error));
    }
  });

  bot.action(/^queue:(cancel|up|next):([a-zA-Z0-9_-]+)$/, async (ctx) => {
    const [, action, turnId] = ctx.match;
    await ctx.answerCbQuery();
    const chatKey = telegram.getChatKey(ctx);
    await queue.pruneExpired(chatKey, ctx);
    let changed = 0;
    if (action === "cancel") changed = await queue.remove(chatKey, turnId);
    else if (action === "up") changed = await queue.move(chatKey, turnId, "up");
    else if (action === "next") changed = await queue.move(chatKey, turnId, "next");
    if (changed === 0) {
      await telegram.replyHtml(ctx, "Queue item not found. Run /queue to refresh.");
      return;
    }
    await telegram.replyHtml(ctx, queue.format(chatKey), queue.keyboard(chatKey));
  });

  registerSelectionRoutes();

  bot.action(/^p:([a-z_]+)$/, async (ctx) => {
    const [, panel] = ctx.match;
    await ctx.answerCbQuery();
    await panels.send(ctx, panel, { edit: true });
  });
  bot.action(/^q:(pause|resume|clear|mode)(?::(safe|interrupt|side))?$/, async (ctx) => {
    const [, action, value] = ctx.match;
    await ctx.answerCbQuery();
    await callbacks.handleQueue(ctx, action, value || "");
  });
  bot.action(/^set:([a-z_]+):([a-z0-9_-]+)$/, async (ctx) => {
    const [, key, value] = ctx.match;
    await ctx.answerCbQuery();
    await callbacks.handleSetting(ctx, key, value);
  });
  bot.action(/^tool:([a-z_]+)$/, async (ctx) => {
    const [, action] = ctx.match;
    await ctx.answerCbQuery();
    await callbacks.handleTool(ctx, action);
  });
  bot.action(/^sk:([a-z]):([0-9]+)$/, async (ctx) => {
    const [, view, page] = ctx.match;
    await ctx.answerCbQuery();
    if (!skills.isView(view)) {
      await telegram.editOrReplyHtml(ctx, b("Invalid skills view"), keyboards.withToolsBack());
      return;
    }
    await skills.replyStatus(
      ctx,
      {
        config: settings.config,
        runtimeValue: settings.runtimeValue,
        replyHtml: telegram.replyHtml,
        editOrReplyHtml: telegram.editOrReplyHtml
      },
      { edit: true, view, page: Number(page), extra: keyboards.withToolsBack() }
    );
  });

  bot.action(/^usage:(refresh|refresh_confirm)$/, async (ctx) => {
    const [, action] = ctx.match;
    await ctx.answerCbQuery();
    await handleUsageRefreshButton(ctx, action);
  });
  bot.action(/^act:(new|resume_last|stop|restart)$/, async (ctx) => {
    const [, action] = ctx.match;
    await ctx.answerCbQuery();
    if (action === "new") await commands.handleNew(ctx);
    else if (action === "resume_last") await commands.handleResume(ctx, "last");
    else if (action === "stop") await commands.handleStop(ctx);
    else if (action === "restart") await commands.handleRestart(ctx);
  });
  bot.action(/^confirm:(q_clear|forget|prefs_reset)$/, async (ctx) => {
    const [, action] = ctx.match;
    await ctx.answerCbQuery();
    await handleConfirmButton(ctx, action);
  });

  function registerSelectionRoutes() {
    bot.action(/^m:([a-f0-9]{6}):([a-zA-Z0-9._-]+|default)$/, async (ctx) => {
      const [, token, model] = ctx.match;
      await selection.handleStandaloneModel(ctx, token, model);
    });
    bot.action(/^r:([a-f0-9]{6}):([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
      const [, token, reasoning] = ctx.match;
      await selection.handleStandaloneReasoning(ctx, token, reasoning);
    });
    bot.action(/^f:([a-f0-9]{6}):(on|off)$/, async (ctx) => {
      const [, token, fast] = ctx.match;
      await selection.handleStandaloneFast(ctx, token, fast);
    });
    bot.action(/^x:([a-f0-9]{6})$/, async (ctx) => {
      const [, token] = ctx.match;
      await selection.handleStandaloneCancel(ctx, token);
    });
    bot.action("ui:close:menu", selection.handleMenuClose);
    bot.action(/^model:set:([a-zA-Z0-9._-]+|default)$/, async (ctx) => {
      const [, model] = ctx.match;
      await ctx.answerCbQuery();
      await selection.handleSettingsModel(ctx, model);
    });
    bot.action(/^reasoning:set:([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
      const [, reasoning] = ctx.match;
      await ctx.answerCbQuery();
      await selection.handleSettingsReasoning(ctx, reasoning);
    });
    bot.action(/^rm:([a-z0-9][a-z0-9_-]{0,49}|default)$/, async (ctx) => {
      const [, reasoning] = ctx.match;
      await ctx.answerCbQuery();
      await selection.handleSettingsReasoning(ctx, reasoning, { continueToFast: true });
    });
  }

  async function handleConfirmButton(ctx, action) {
    const chatKey = telegram.getChatKey(ctx);
    if (action === "q_clear") {
      const cleared = await queue.clear(chatKey);
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("clearQueueDone"))}\nCleared queued turns: ${code(cleared)}`,
        queue.keyboard(chatKey)
      );
      return;
    }
    if (action === "forget") {
      if (await chats.rejectCallbackIfActive(ctx, chatKey)) return;
      threadCache.delete(chatKey);
      delete state.chats[chatKey];
      delete state.queues[chatKey];
      pendingTurns.delete(chatKey);
      await persistence.save();
      await telegram.editOrReplyHtml(
        ctx,
        localization.text("forgetDone"),
        keyboards.backToMain()
      );
      return;
    }
    if (action === "prefs_reset") {
      if (await chats.rejectCallbackIfActive(ctx, chatKey)) return;
      const chat = chats.get(chatKey);
      chat.options = {};
      delete chat.outputSchema;
      chats.invalidateThreadCache(chatKey);
      await persistence.save();
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("prefsResetDone"))}\n\n${panels.settingsHtml(chatKey)}`,
        keyboards.settings()
      );
    }
  }

  async function handleUsageRefreshButton(ctx, action) {
    const chatKey = telegram.getChatKey(ctx);
    if (action === "refresh") {
      if (await chats.rejectCallbackIfActive(ctx, chatKey)) return;
      if (queue.sideTurnCount(chatKey) > 0) {
        await telegram.editOrReplyHtml(
          ctx,
          `Codex side turn is already running. Use ${code("/stop")} first.`,
          status.keyboard(chatKey)
        );
        return;
      }
      if (usageRefreshes.has(chatKey)) {
        await showUsageRefreshRunning(ctx, chatKey);
        return;
      }
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("usageRefreshConfirmTitle"))}\n${localization.text("usageRefreshConfirmBody")}`,
        keyboards.withClose(keyboards.inline([
          [
            { text: localization.text("usageRefreshRun"), callback_data: "usage:refresh_confirm" },
            { text: localization.text("cancel"), callback_data: "p:status" }
          ],
          [{ text: `← ${localization.text("back")}`, callback_data: "p:status" }]
        ]))
      );
      return;
    }

    if (await chats.rejectCallbackIfActive(ctx, chatKey)) return;
    if (queue.sideTurnCount(chatKey) > 0) {
      await telegram.editOrReplyHtml(
        ctx,
        `Codex side turn is already running. Use ${code("/stop")} first.`,
        status.keyboard(chatKey)
      );
      return;
    }
    if (usageRefreshes.has(chatKey)) {
      await showUsageRefreshRunning(ctx, chatKey);
      return;
    }

    const abortController = new AbortController();
    usageRefreshes.set(chatKey, abortController);
    await showUsageRefreshRunning(ctx, chatKey);
    try {
      await timing.withTimeout(
        usage.refreshSample(chatKey, abortController.signal),
        60000,
        "Usage refresh timed out."
      );
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("usageRefreshDoneTitle"))}\n\n${status.format(chatKey, await status.buildDetails(chatKey))}`,
        status.keyboard(chatKey)
      );
    } catch (error) {
      abortController.abort();
      await telegram.editOrReplyHtml(
        ctx,
        `${b(localization.text("usageRefreshFailedTitle"))}\n${code(error instanceof Error ? error.message : String(error))}`,
        status.keyboard(chatKey)
      );
    } finally {
      usageRefreshes.delete(chatKey);
    }
  }

  async function showUsageRefreshRunning(ctx, chatKey) {
    await telegram.editOrReplyHtml(
      ctx,
      `${b(localization.text("usageRefreshRunningTitle"))}\n${localization.text("usageRefreshRunningBody")}`,
      status.keyboard(chatKey, { closable: false })
    );
  }
}
