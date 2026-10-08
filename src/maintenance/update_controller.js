import { approvedArtifact } from "./update_artifact.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createMessageFormatter } from "../i18n.js";
import { b, code } from "../telegram/html.js";
import { telegramContextMeta } from "../telegram/context.js";
import { claimUpdate, readUpdateState, releaseUpdate, UPDATE_TERMINAL_PHASES, writeUpdateState } from "./update_state.js";
import { codexInstallation, latestCodexVersion, newerVersion, runUpdateProcess } from "./update_install.js";
import { validateServiceName } from "./update_runner.js";

export function createCodexUpdateController({
  config, appRoot, telegram, keyboards, text, language,
  run = runUpdateProcess, inspect = codexInstallation, latest = latestCodexVersion,
  now = Date.now
}) {
  const msg = createMessageFormatter(text);
  const previews = new Map();
  const admin = (ctx) => config.codexUpdateAdminUserIds?.has(String(ctx.from?.id)) === true;
  const ownerKey = (ctx) => `${ctx.from?.id}:${telegram.getChatKey(ctx)}:${ctx.callbackQuery?.message?.message_id || ""}`;
  const keyboard = (rows) => keyboards.withClose(keyboards.inline([
    ...rows,
    [{ text: text("refresh"), callback_data: "tool:codex_update" }],
    [{ role: "back", text: `← ${text("back")}`, callback_data: "tool:codex_maintenance" }]
  ]));
  const edit = (ctx, html, rows = []) => telegram.editOrReplyHtml(ctx, html, keyboard(rows));
  async function unitActive(unit) {
    try {
      const value = (await run("systemctl", ["--user", "is-active", unit], { timeout: 10_000 })).stdout.trim();
      return ["active", "activating", "reloading", "deactivating"].includes(value);
    } catch (error) { if (typeof error.code === "number") return false; throw error; }
  }
  async function launch(state) {
    await run("systemd-run", ["--user", `--unit=${state.unit}`, "--collect",
      "--property=Type=exec", "--property=Restart=on-failure", "--property=RestartSec=3",
      "--property=StartLimitBurst=3", "--property=RuntimeMaxSec=7200",
      `--working-directory=${appRoot}`, "flock", "--exclusive", "--nonblock",
      path.join(state.installation.root, "install.lock"), process.execPath,
      path.join(appRoot, "scripts/codex-update.mjs"), "--id", state.id], { timeout: 15_000 });
  }
  async function showRun(ctx, state) {
    const alive = await unitActive(state.unit);
    const interrupted = !alive && !UPDATE_TERMINAL_PHASES.has(state.phase)
      && now() - Date.parse(state.updatedAt) > 15_000;
    const rows = admin(ctx) && interrupted ? [[{
      text: msg("ui.codexUpdateRecover"), callback_data: `tool:codex_update_recover:${state.id}`, style: "primary"
    }]] : [];
    await edit(ctx, [
      b(msg("ui.codexUpdateTitle")),
      msg("ui.codexUpdateVersions", { current: code(state.installation.current), latest: code(state.target) }),
      msg(`ui.codexUpdatePhase.${state.phase}`),
      interrupted ? msg("ui.codexUpdateInterrupted") : "",
      state.error ? code(state.error) : "",
      state.rollbackError ? code(state.rollbackError) : ""
    ].filter(Boolean).join("\n\n"), rows);
  }
  async function show(ctx) {
    const state = await readUpdateState(config);
    if (state && !UPDATE_TERMINAL_PHASES.has(state.phase)) return showRun(ctx, state);
    const installation = await inspect(config, run);
    const target = await latest(run);
    let trustError = "";
    if (installation.supported && newerVersion(target, installation.current)) {
      try { await approvedArtifact(config, target); } catch (error) { trustError = error.message; }
    }
    const updatable = installation.supported && newerVersion(target, installation.current) && !trustError;
    const rows = [];
    if (updatable && admin(ctx)) {
      for (const [id, entry] of previews) { if (entry.expiresAt < now()) previews.delete(id); }
      const id = randomUUID();
      previews.set(id, { installation, target, owner: ownerKey(ctx), expiresAt: now() + 10 * 60_000 });
      rows.push([{ text: msg("ui.codexUpdateStart"), callback_data: `tool:codex_update_start:${id}`, style: "primary" }]);
    }
    await edit(ctx, [
      b(msg("ui.codexUpdateTitle")),
      msg("ui.codexUpdateVersions", { current: code(installation.current), latest: code(target) }),
      installation.supported
        ? newerVersion(target, installation.current) ? msg("ui.codexUpdateAvailable") : msg("ui.codexUpdateCurrent")
        : msg("ui.codexUpdateUnsupported"),
      msg("ui.codexUpdateScope"),
      trustError ? code(trustError) : "",
      !admin(ctx) ? msg("ui.codexUpdateAdminOnly") : "",
      state ? msg("ui.codexUpdateLastResult", { status: msg(`ui.codexUpdatePhase.${state.phase}`) }) : ""
    ].filter(Boolean).join("\n\n"), rows);
  }
  async function start(ctx, id) {
    if (!admin(ctx)) return edit(ctx, msg("ui.codexUpdateAdminOnly"));
    const current = await readUpdateState(config);
    if (current && !UPDATE_TERMINAL_PHASES.has(current.phase)) return showRun(ctx, current);
    const preview = previews.get(id);
    if (!preview || preview.owner !== ownerKey(ctx) || preview.expiresAt < now()) {
      return edit(ctx, msg("ui.codexUpdateExpired"));
    }
    const observed = await inspect(config, run);
    if (!observed.supported || observed.real !== preview.installation.real || observed.current !== preview.installation.current) {
      return edit(ctx, msg("ui.codexUpdateExpired"));
    }
    await approvedArtifact(config, preview.target);
    validateServiceName(config.codexUpdateBotService);
    validateServiceName(config.codexUpdateWorkerService);
    validateServiceName(config.codexUpdateAppServerService);
    // Refuse misconfigured services before starting a host operation.
    const directory = (await run("systemctl", ["--user", "show", config.codexUpdateBotService, "--property=WorkingDirectory", "--value"], { timeout: 10_000 })).stdout.trim();
    if (path.resolve(directory) !== appRoot) throw new Error("Update bot service WorkingDirectory does not match this repository.");
    const me = ctx.botInfo || await ctx.telegram.getMe();
    const meta = telegramContextMeta(ctx);
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Update panel message ID required.");
    const state = {
      id, unit: `codex-cli-update-${id}.service`, phase: "launching",
      installation: observed, target: preview.target, requestedBy: String(ctx.from.id),
      language: language(), startedAt: new Date(now()).toISOString(),
      origin: { botId: String(me.id), chatId: String(meta.chatId), threadId: String(meta.messageThreadId || ""), messageId: String(messageId) }
    };
    if (!await claimUpdate(config, state)) return edit(ctx, msg("ui.codexUpdateLocked"));
    previews.delete(id);
    try { await launch(state); }
    catch (error) {
      // A launch timeout may have started the detached service. Keep its lock
      // until status is known; never allow a duplicate activation.
      if (typeof error.code === "number" && !await unitActive(state.unit)) {
        await writeUpdateState(config, { ...state, phase: "failed", error: String(error.message).slice(0, 1000) });
        await releaseUpdate(config, id);
      }
      throw error;
    }
    return showRun(ctx, await readUpdateState(config));
  }
  async function recover(ctx, id) {
    if (!admin(ctx)) return edit(ctx, msg("ui.codexUpdateAdminOnly"));
    const state = await readUpdateState(config);
    if (!state || state.id !== id || UPDATE_TERMINAL_PHASES.has(state.phase)) return edit(ctx, msg("ui.codexUpdateExpired"));
    if (!await unitActive(state.unit)) {
      await run("systemctl", ["--user", "reset-failed", state.unit], { timeout: 10_000 }).catch(() => {});
      await launch(state);
    }
    return showRun(ctx, state);
  }
  async function handle(ctx, action, id) {
    try {
      if (action === "codex_update_start") return await start(ctx, id);
      if (action === "codex_update_recover") return await recover(ctx, id);
      return await show(ctx);
    } catch (error) {
      return edit(ctx, `${b(msg("ui.codexUpdateError"))}\n${code(String(error.message).slice(0, 1500))}`);
    }
  }
  return { handle };
}
