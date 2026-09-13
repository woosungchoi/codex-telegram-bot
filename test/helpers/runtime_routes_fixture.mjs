import { workspaceFixture } from "./workspace_fixture.mjs";
import { registerRuntimeRoutes } from "../../src/runtime/route_composition.js";
import { createRuntimePanelController } from "../../src/ui/runtime_panel_controller.js";
import { createRuntimeKeyboardViews } from "../../src/ui/keyboards.js";
import { createRuntimePanelViews, formatKeyValueHtml } from "../../src/ui/panels.js";
import { createSettingsCallbackController } from "../../src/ui/settings_callback_controller.js";
import { createToolCallbackController } from "../../src/ui/tool_callback_controller.js";
import { createStandaloneModelSelectionController } from "../../src/ui/standalone_model_selection_controller.js";
import { textFor } from "../../src/i18n.js";

export async function runtimeRoutesFixture(t, options = {}) {
  const forwarded = [], usageReads = [];
  const fixture = await workspaceFixture(t, {
    ...options,
    register(r, workspace) {
      const text = (key) => textFor(r.state.ui.language, key);
      const localization = { text, language: () => r.state.ui.language, timeZone: () => "Asia/Seoul", locale: () => "ko-KR" };
      const v = createRuntimeKeyboardViews({ text, hasActiveTurn: (key) => r.activeTurns.has(key), sideTurnCount: r.getSideTurnCount,
        currentLanguage: localization.language, currentTimeZone: localization.timeZone, currentLocale: localization.locale });
      const keyboards = { ...Object.fromEntries(Object.entries(v).filter(([key]) => key.endsWith("Keyboard"))
        .map(([key, value]) => [key.slice(0, -8), value])), withClose: v.withMenuCloseButton,
        withPrevious: v.withPreviousPanelButton, previousPanelFor: v.previousPanelFor, withToolsBack: v.withToolsBack };
      const views = createRuntimePanelViews({ text, formatText: (key, vars) => Object.entries(vars).reduce((s, [k, val]) => s.replaceAll(`{${k}}`, val), text(key)) });
      const chats = { get: r.getChatState, getEffectiveOptions: r.getEffectiveOptions, formatOptions: () => "Options",
        setOption: async (key, name, value) => { r.getChatState(key).options[name] = value; await r.saveState(); } };
      const runtimeValue = (key) => r.state.runtime?.[key] ?? false;
      const telegram = { ...r, summarizeError: (error) => ({ description: error.message }), rejectCallbackIfActive: async () => false };
      const status = { buildDetails: async () => ({}), formatQueue: () => "Queue", formatStatus: () => "Status" };
      const diagnostics = { formatHealth: async () => "Health OK", formatDoctor: async () => "Doctor OK",
        formatLogs: async () => "Logs OK", formatWhoami: () => "Identity", formatConfig: () => "Config" };
      const panels = createRuntimePanelController({ settings: { config: r.config, runtimeValue, runtimeSeconds: () => 0 },
        state: r.state, threadCache: r.threadCache, chats, queue: { countPending: () => 0, pruneExpired: async () => {} },
        status, models: {}, keyboards,
        views: Object.fromEntries(Object.entries(views).map(([key, value]) => [key.replace("PanelHtml", ""), value])),
        telegram, localization, formatting: { keyValue: formatKeyValueHtml, optional: String, duration: String }, help: { html: () => "Help" } });
      const settings = createSettingsCallbackController({ settings: { config: r.config, runtimeValue, saveState: r.saveState,
        updateRuntimeSetting: async (key, value) => { (r.state.runtime ||= {})[key] = value; await r.saveState(); } },
        state: r.state, chats, keyboards, panels: { runtimeHtml: panels.runtimePanelHtml, settingsHtml: panels.settingsPanelHtml }, telegram, localization });
      const tools = createToolCallbackController({ settings: { config: r.config, runtimeValue }, state: r.state,
        telegram, keyboards, diagnostics, localization });
      Object.assign(r, v, settings, tools, {
        text, runtimeValue, handleRestartCommand: async () => { throw new Error("Restart disabled in integration tests"); }, valid: { approval: new Set(), sandbox: new Set(), webSearch: new Set(), queueMode: new Set(["safe"]) },
        pendingTurns: new Map(), usageRefreshes: new Map(), sendPanel: panels.sendPanel, settingsPanelHtml: panels.settingsPanelHtml,
        formatKeyValueHtml, summarizeTelegramError: telegram.summarizeError, pruneExpiredPendingTurns: async () => {},
        buildStatusDetails: status.buildDetails, formatStatusHtml: status.formatStatus,
        handleCodexMessage: async (_ctx, input) => forwarded.push(input),
        handleMenuClose: createStandaloneModelSelectionController({ text, views: v,
          telegram: { editStrict: async (ctx, html, extra) => { await r.editOrReplyHtml(ctx, html, extra); return true; },
            answerUiCallback: (ctx) => ctx.answerCbQuery() }
        }).handleMenuClose
      });
      return registerRuntimeRoutes(r, { workspace, accounts: { store: workspace.accounts, now: workspace.now,
        readUsage: async (_config, id) => { usageReads.push(id); return { account: { type: "chatgpt" }, rateLimits: {}, checkedAt: workspace.now() }; },
        signIn: async () => { throw new Error("Login is disabled in route integration tests"); }
      } }).workspaceMenus;
    }
  });
  return { ...fixture, forwarded, usageReads };
}
