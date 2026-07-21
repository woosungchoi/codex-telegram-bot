import { b, code } from "./html.js";

export function registerChatCommands({
  bot,
  settings,
  activeTurns,
  threadCache,
  chats,
  threads,
  sessions,
  turns,
  models,
  options,
  panels,
  status,
  queue,
  telegram,
  localization,
  formatting,
  filesystem,
  persistence
}) {
  bot.start(async (ctx) => {
    await telegram.replyHtml(ctx, panels.helpHtml());
  });

  bot.help(async (ctx) => {
    await telegram.replyHtml(ctx, panels.helpHtml());
  });

  bot.command("menu", async (ctx) => {
    await panels.send(ctx, "main");
  });

  bot.command("new", handleNewCommand);

  async function handleNewCommand(ctx) {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;

    const previousThreadId = chats.get(chatKey).threadId || threadCache.get(chatKey)?.id || "";
    const thread = threads.start(chatKey);
    threadCache.set(chatKey, thread);
    const chat = chats.get(chatKey);
    delete chat.threadId;
    chat.updatedAt = new Date().toISOString();
    await persistence.save();

    const abortController = new AbortController();
    activeTurns.set(chatKey, { abortController });
    let finalReaction = "";
    await telegram.reactQuietly(ctx, settings.config.telegramThinkingReaction);
    try {
      await turns.run(
        ctx,
        chatKey,
        thread,
        turns.applyPersonaPrompt(localization.text("newThreadPersonaPrompt")),
        abortController.signal
      );
      await threads.remember(chatKey, thread);
      await telegram.replyHtml(ctx, formatting.keyValue("New Codex thread started.", [
        ["Previous thread", previousThreadId || "none"],
        ["New thread", thread.id || "unknown"],
        ["Workdir", chats.getEffectiveOptions(chatKey).workingDirectory]
      ]));
      finalReaction = settings.config.telegramCompleteReaction;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finalReaction = abortController.signal.aborted
        ? settings.config.telegramStoppedReaction
        : settings.config.telegramErrorReaction;
      await telegram.replyHtml(
        ctx,
        `<b>Failed to start new Codex thread</b>\n${code(message)}`
      );
    } finally {
      await telegram.reactQuietly(
        ctx,
        finalReaction,
        finalReaction === settings.config.telegramCompleteReaction
      );
      activeTurns.delete(chatKey);
    }
  }

  bot.command("resume", (ctx) => handleResumeCommand(ctx));
  bot.command("resume_last", (ctx) => handleResumeCommand(ctx, "last"));

  async function handleResumeCommand(ctx, overrideArg = null) {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;

    const arg = overrideArg ?? telegram.getCommandArgs(ctx).trim();
    let threadId = arg;
    let session = null;
    if (!threadId || threadId.toLowerCase() === "last") {
      session = (await sessions.listRecent(1))[0] ?? null;
      threadId = session?.id ?? "";
    }
    if (!threadId) {
      await telegram.replyHtml(ctx, `No Codex session found. Use ${code("/new")} to start one.`);
      return;
    }

    const thread = threads.resume(chatKey, threadId);
    threadCache.set(chatKey, thread);
    const chat = chats.get(chatKey);
    chat.threadId = threadId;
    chat.updatedAt = new Date().toISOString();
    await persistence.save();
    await telegram.replyHtml(ctx, formatting.keyValue("Resumed Codex thread.", [
      ["Thread", threadId],
      ...(session ? [["Source", session.cwd], ["Time", session.timestamp]] : [])
    ]));
  }

  bot.command("threads", async (ctx) => {
    const recent = await sessions.listRecent(8);
    if (recent.length === 0) {
      await telegram.replyHtml(ctx, "No Codex sessions found.");
      return;
    }
    const lines = [b("Recent Codex sessions:")];
    for (const session of recent) {
      lines.push(
        "",
        code(session.id),
        `- time: ${code(session.timestamp)}`,
        `- cwd: ${code(session.cwd)}`,
        `- source: ${code(`${session.source}/${session.originator}`)}`,
        `- resume: ${code(`/resume ${session.id}`)}`
      );
    }
    await telegram.replyHtml(ctx, lines.join("\n"));
  });

  bot.command("status", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    await queue.pruneExpired(chatKey, ctx);
    await telegram.replyHtml(
      ctx,
      status.format(chatKey, await status.buildDetails(chatKey)),
      status.keyboard(chatKey)
    );
  });
  bot.command("options", (ctx) => telegram.replyHtml(
    ctx,
    options.format(telegram.getChatKey(ctx))
  ));
  bot.command("settings", (ctx) => panels.send(ctx, "settings"));

  bot.command("model", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (telegram.getCommandArgs(ctx).trim()) {
      await options.updateCommand(ctx, "model", "model name or off");
      return;
    }
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    await models.sendStandaloneModelSelection(ctx, chatKey);
  });
  bot.command("model_off", (ctx) => options.updateValue(ctx, "model", "off"));
  bot.command("workdir", (ctx) => options.updateCommand(
    ctx,
    "workingDirectory",
    "absolute directory"
  ));
  bot.command("workdir_default", (ctx) => options.updateValue(
    ctx,
    "workingDirectory",
    "default"
  ));

  bot.command("sandbox", (ctx) => options.updateCommand(
    ctx,
    "sandboxMode",
    [...settings.validSandboxModes].join("|")
  ));
  registerValueCommands("sandbox", {
    read_only: ["sandboxMode", "read-only"],
    workspace_write: ["sandboxMode", "workspace-write"],
    danger_full_access: ["sandboxMode", "danger-full-access"],
    default: ["sandboxMode", "default"]
  });

  bot.command("approval", (ctx) => options.updateCommand(
    ctx,
    "approvalPolicy",
    [...settings.validApprovalPolicies].join("|")
  ));
  registerValueCommands("approval", {
    never: ["approvalPolicy", "never"],
    on_request: ["approvalPolicy", "on-request"],
    on_failure: ["approvalPolicy", "on-failure"],
    untrusted: ["approvalPolicy", "untrusted"],
    default: ["approvalPolicy", "default"]
  });

  bot.command("reasoning", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    const value = telegram.getCommandArgs(ctx).trim();
    if (value) {
      await options.updateValue(ctx, "modelReasoningEffort", value.toLowerCase());
      return;
    }
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    await models.sendStandaloneReasoningSelection(ctx, chatKey);
  });
  for (const reasoning of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"]) {
    bot.command(`reasoning_${reasoning}`, (ctx) => options.updateValue(
      ctx,
      "modelReasoningEffort",
      reasoning
    ));
  }

  bot.command("fast", (ctx) => handleFastCommand(ctx));
  bot.command("fast_on", (ctx) => handleFastCommand(ctx, "on"));
  bot.command("fast_off", (ctx) => handleFastCommand(ctx, "off"));
  bot.command("fast_status", (ctx) => handleFastCommand(ctx, "status"));

  async function handleFastCommand(ctx, overrideArg = null) {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    const arg = (overrideArg ?? telegram.getCommandArgs(ctx).trim()).toLowerCase();
    const chat = chats.get(chatKey);
    const fastEnabled = chats.getEffectiveOptions(chatKey).serviceTier === "fast";
    const catalog = await models.list();
    if (arg === "status") {
      await telegram.replyHtml(ctx, models.formatFastStatus(chatKey, catalog));
      return;
    }
    if (!arg || arg === "toggle") {
      if (fastEnabled) delete chat.options.serviceTier;
      else chat.options.serviceTier = "fast";
    } else if (["on", "true", "yes", "1"].includes(arg)) {
      chat.options.serviceTier = "fast";
    } else if (["off", "false", "no", "0", "default"].includes(arg)) {
      delete chat.options.serviceTier;
    } else {
      await telegram.replyHtml(
        ctx,
        `Usage: ${code("/fast")}, ${code("/fast_on")}, ${code("/fast_off")}, or ${code("/fast_status")}`
      );
      return;
    }
    chats.invalidateThreadCache(chatKey);
    await persistence.save();
    await telegram.replyHtml(
      ctx,
      `${b("Fast service tier updated.")}\n\n${models.formatFastStatus(chatKey, catalog)}`
    );
  }

  bot.command("websearch", (ctx) => options.updateCommand(
    ctx,
    "webSearchMode",
    [...settings.validWebSearchModes].join("|")
  ));
  registerSimpleValues("websearch", "webSearchMode", ["disabled", "cached", "live", "default"]);
  bot.command("network", (ctx) => options.updateCommand(ctx, "networkAccessEnabled", "on|off"));
  registerSimpleValues("network", "networkAccessEnabled", ["on", "off", "default"]);
  bot.command("skipgit", (ctx) => options.updateCommand(ctx, "skipGitRepoCheck", "on|off"));
  registerSimpleValues("skipgit", "skipGitRepoCheck", ["on", "off", "default"]);

  bot.command("adddir", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    const dir = telegram.getCommandArgs(ctx).trim();
    if (!dir) {
      await telegram.replyHtml(ctx, `Usage: ${code("/adddir <absolute-directory>")}`);
      return;
    }
    await filesystem.ensureDirectory(dir, "additional directory");
    const chat = chats.get(chatKey);
    chat.options.additionalDirectories = formatting.unique([
      ...(chat.options.additionalDirectories ?? []),
      dir
    ]);
    chats.invalidateThreadCache(chatKey);
    await persistence.save();
    await telegram.replyHtml(ctx, `Added directory: ${code(dir)}`);
  });

  bot.command("cleardirs", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    delete chats.get(chatKey).options.additionalDirectories;
    chats.invalidateThreadCache(chatKey);
    await persistence.save();
    await telegram.replyHtml(ctx, "Cleared additional directories.");
  });

  bot.command("stream", (ctx) => options.updateCommand(ctx, "streamEvents", "on|off"));
  registerSimpleValues("stream", "streamEvents", ["on", "off", "default"]);

  bot.command("schema", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    const value = telegram.getCommandArgs(ctx).trim();
    if (!value) {
      await telegram.replyHtml(
        ctx,
        `Usage: ${code("/schema <json-schema>")} or ${code("/schema off")}`
      );
      return;
    }
    const chat = chats.get(chatKey);
    if (value.toLowerCase() === "off") {
      delete chat.outputSchema;
      await persistence.save();
      await telegram.replyHtml(ctx, "Structured output schema disabled.");
      return;
    }
    try {
      chat.outputSchema = JSON.parse(value);
    } catch (error) {
      await telegram.replyHtml(
        ctx,
        `<b>Invalid JSON schema</b>\n${code(error instanceof Error ? error.message : String(error))}`
      );
      return;
    }
    await persistence.save();
    await telegram.replyHtml(ctx, "Structured output schema enabled for this chat.");
  });

  bot.command("schema_off", async (ctx) => {
    const chatKey = telegram.getChatKey(ctx);
    if (await chats.rejectIfActive(ctx, chatKey)) return;
    delete chats.get(chatKey).outputSchema;
    await persistence.save();
    await telegram.replyHtml(ctx, "Structured output schema disabled.");
  });

  function registerSimpleValues(prefix, option, values) {
    for (const value of values) {
      bot.command(`${prefix}_${value}`, (ctx) => options.updateValue(ctx, option, value));
    }
  }

  function registerValueCommands(prefix, commands) {
    for (const [suffix, [option, value]] of Object.entries(commands)) {
      bot.command(`${prefix}_${suffix}`, (ctx) => options.updateValue(ctx, option, value));
    }
  }

  return {
    handleFastCommand,
    handleNewCommand,
    handleResumeCommand
  };
}
