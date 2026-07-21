import { b, code } from "./html.js";

export function registerAdminCommands({
  bot,
  settings,
  state,
  activeTurns,
  threadCache,
  pendingTurns,
  chats,
  panels,
  diagnostics,
  skills,
  backup,
  recovery,
  queue,
  cleanup,
  telegram,
  localization,
  formatting,
  persistence
}) {
  bot.command("config", (ctx) => telegram.replyHtml(ctx, diagnostics.formatConfig()));
  bot.command("doctor", async (ctx) => telegram.replyHtml(
    ctx,
    await diagnostics.formatDoctor(telegram.getChatKey(ctx))
  ));
  bot.command("health", async (ctx) => telegram.replyHtml(ctx, await diagnostics.formatHealth()));
  bot.command("tools", (ctx) => panels.send(ctx, "tools"));
  bot.command("skills", (ctx) => skills.replyStatus(
    ctx,
    {
      config: settings.config,
      runtimeValue: settings.runtimeValue,
      replyHtml: telegram.replyHtml,
      editOrReplyHtml: telegram.editOrReplyHtml
    },
    { query: commandArgument(ctx.message?.text, "skills") }
  ));

  bot.command("backup", async (ctx) => {
    const result = await backup.createState("manual");
    await telegram.replyHtml(ctx, formatting.keyValue("Backup created:", [
      ["file", result.path],
      ["size", formatting.bytes(result.bytes)],
      ["chats", result.chatCount]
    ]));
    await telegram.replyDocument(ctx, result.path, "Codex Telegram Bot backup");
  });

  bot.command("export", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    const file = await backup.createChatExport(chatKey);
    await telegram.replyHtml(ctx, formatting.keyValue("Chat export created:", [
      ["file", file.path],
      ["size", formatting.bytes(file.bytes)]
    ]));
    await telegram.replyDocument(ctx, file.path, "Current chat export");
  });

  bot.command("prefs", (ctx) => handlePrefsCommand(ctx));
  bot.command("prefs_reset", (ctx) => handlePrefsCommand(ctx, "reset"));

  async function handlePrefsCommand(ctx, overrideArg = null) {
    const chatKey = telegram.getChatKey(ctx);
    const arg = (overrideArg ?? telegram.getCommandArgs(ctx).trim()).toLowerCase();
    if (arg === "reset") {
      if (await chats.rejectIfActive(ctx, chatKey)) return;
      const chat = chats.get(chatKey);
      chat.options = {};
      delete chat.outputSchema;
      chats.invalidateThreadCache(chatKey);
      await persistence.save();
      await telegram.replyHtml(
        ctx,
        `${b("Preferences reset.")}\n\n${formatting.formatPrefs(chatKey)}`
      );
      return;
    }
    if (arg) {
      await telegram.replyHtml(ctx, `Usage: ${code("/prefs")} or ${code("/prefs_reset")}`);
      return;
    }
    await telegram.replyHtml(ctx, formatting.formatPrefs(chatKey));
  }

  bot.command("whoami", (ctx) => telegram.replyHtml(ctx, diagnostics.formatWhoami(ctx)));
  bot.command("logs", async (ctx) => telegram.replyHtml(ctx, await diagnostics.formatLogs(ctx)));
  bot.command("logs_error", async (ctx) => telegram.replyHtml(
    ctx,
    await diagnostics.formatLogs(ctx, "error")
  ));
  bot.command("stop", handleStopCommand);

  async function handleStopCommand(ctx) {
    const chatKey = telegram.getChatKey(ctx);
    const active = activeTurns.get(chatKey);
    const stoppedSideTurns = queue.stopSideTurns(chatKey);
    if (!active && stoppedSideTurns === 0) {
      await telegram.replyHtml(ctx, "No active Codex turn.");
      return;
    }
    if (active) {
      active.stopRequested = true;
      await recovery.markActiveTurnStopped(chatKey);
      recovery.cancelWorkerJobOnce(active, active.workerJobId);
      active.abortController?.abort();
    }
    const cleared = await queue.clearPending(chatKey);
    await telegram.replyHtml(
      ctx,
      `Stop requested.${cleared > 0 ? ` Cleared queued turns: ${code(cleared)}` : ""}${stoppedSideTurns > 0 ? ` Stopped side turns: ${code(stoppedSideTurns)}` : ""}`
    );
  }

  bot.command("restart", recovery.handleRestartCommand);
  bot.command("restart_continue", recovery.handleRestartCommand);
  bot.command("recovery_status", async (ctx) => telegram.replyHtml(
    ctx,
    await recovery.formatStatus()
  ));
  bot.command("recovery_resume", async (ctx) => {
    const started = await recovery.scheduleStartup({ force: true, notifyCtx: ctx });
    await telegram.replyHtml(
      ctx,
      started
        ? localization.text("recoveryManualResumeStarted")
        : localization.text("recoveryNoCandidates")
    );
  });
  bot.command("recovery_cancel", async (ctx) => {
    await recovery.clearCompleted(settings.config.botRecoveryDir);
    await recovery.clearPendingTurns();
    await telegram.replyHtml(ctx, localization.text("recoveryCancelled"));
  });

  bot.command("queue", (ctx) => handleQueueCommand(ctx));
  bot.command("queue_pause", (ctx) => handleQueueCommand(ctx, "pause"));
  bot.command("queue_resume", (ctx) => handleQueueCommand(ctx, "resume"));
  bot.command("queue_mode", (ctx) => handleQueueCommand(ctx, "mode"));
  for (const mode of ["safe", "interrupt", "side"]) {
    bot.command(`queue_mode_${mode}`, (ctx) => handleQueueCommand(ctx, `mode ${mode}`));
  }

  async function handleQueueCommand(ctx, overrideArg = null) {
    const chatKey = telegram.getChatKey(ctx);
    const arg = (overrideArg ?? telegram.getCommandArgs(ctx).trim()).toLowerCase();
    const [subcommand, value] = arg.split(/\s+/, 2);
    if (subcommand === "mode") {
      if (!value) {
        await telegram.replyHtml(ctx, queue.formatMode(chatKey));
        return;
      }
      if (!settings.validQueueModes.has(value)) {
        await telegram.replyHtml(
          ctx,
          `Usage: ${code("/queue_mode")} or ${code("/queue_mode_safe|interrupt|side")}`
        );
        return;
      }
      await queue.setMode(chatKey, value);
      await telegram.replyHtml(
        ctx,
        `${b(localization.text("queueUpdatedTitle"))}\n\n${queue.formatMode(chatKey)}`
      );
      return;
    }
    if (arg === "pause") {
      await queue.setPaused(chatKey, true);
      await telegram.replyHtml(
        ctx,
        `${b(localization.text("queuePausedTitle"))}\n${localization.text("queuePausedDetail")}\n\n${queue.format(chatKey)}`,
        queue.keyboard(chatKey)
      );
      return;
    }
    if (arg === "resume") {
      await queue.setPaused(chatKey, false);
      const started = await queue.startDrain(chatKey, ctx);
      await telegram.replyHtml(
        ctx,
        `${b(localization.text("queueResumedTitle"))}${started ? `\n${localization.text("queueProcessingRestarted")}` : ""}\n\n${queue.format(chatKey)}`,
        queue.keyboard(chatKey)
      );
      return;
    }
    if (arg && arg !== "status") {
      await telegram.replyHtml(
        ctx,
        `Usage: ${code("/queue")}, ${code("/queue_pause")}, ${code("/queue_resume")}, or ${code("/queue_mode")}`
      );
      return;
    }
    await queue.pruneExpired(chatKey, ctx);
    await telegram.replyHtml(ctx, queue.format(chatKey), queue.keyboard(chatKey));
  }

  bot.command("cancelqueue", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    const arg = telegram.getCommandArgs(ctx).trim();
    const cleared = arg
      ? await queue.removePending(chatKey, arg)
      : await queue.clearPending(chatKey);
    await telegram.replyHtml(
      ctx,
      cleared > 0 ? `Cleared queued turns: ${code(cleared)}` : "No queued Codex turns."
    );
  });

  bot.command("forget", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    threadCache.delete(chatKey);
    delete state.chats[chatKey];
    delete state.queues[chatKey];
    pendingTurns.delete(chatKey);
    await persistence.save();
    await telegram.replyHtml(ctx, "Forgot the Codex thread and chat-specific options.");
  });

  bot.command("cleanup", (ctx) => handleCleanupCommand(ctx));
  bot.command("cleanup_status", (ctx) => handleCleanupCommand(ctx, "status"));
  bot.command("cleanup_uploads", async (ctx) => {
    const plan = await cleanup.createUploadPlan({ dryRun: true });
    const record = cleanup.createUploadPlanRecord(plan);
    state.uploadCleanup.plans[record.id] = record;
    await cleanup.appendLog(cleanup.createUploadPlanLogEntry(plan, {
      planId: record.id,
      at: record.createdAt
    }));
    await persistence.save();
    await telegram.replyHtml(
      ctx,
      cleanup.formatUploadPlan(plan, record),
      cleanup.uploadKeyboard(record.id)
    );
  });
  bot.command("cleanup_uploads_confirm", (ctx) => telegram.replyHtml(
    ctx,
    `${b("Upload cleanup confirmation changed")}\nRun ${code("/cleanup_uploads")} and press the ${code("Confirm upload cleanup")} button. This command no longer deletes files.`
  ));

  async function handleCleanupCommand(ctx, overrideArg = null) {
    const arg = (overrideArg ?? telegram.getCommandArgs(ctx).trim()).toLowerCase();
    if (!arg || arg === "status" || arg === "dry-run") {
      const plan = await cleanup.createPlan("manual");
      await persistence.save();
      await cleanup.sendPlan(ctx, plan);
      return;
    }
    await telegram.replyHtml(
      ctx,
      `Usage: ${code("/cleanup")} or ${code("/cleanup_status")}`
    );
  }

  return {
    handleCleanupCommand,
    handlePrefsCommand,
    handleQueueCommand,
    handleStopCommand
  };
}

export function commandArgument(text, command) {
  const trimmed = String(text || "").trimStart();
  const token = trimmed.split(/\s+/, 1)[0] || "";
  const bareCommand = token.replace(/^\//, "").split("@", 1)[0].toLowerCase();
  return bareCommand === command ? trimmed.slice(token.length).trim() : "";
}
