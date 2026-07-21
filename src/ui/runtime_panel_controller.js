import { createRuntimePanelPresenter } from "./runtime_panel_presenter.js";
import { createRuntimePanelResolver } from "./runtime_panel_resolver.js";

export function createRuntimePanelController({
  settings,
  state,
  threadCache,
  chats,
  queue,
  status,
  models,
  keyboards,
  views,
  telegram,
  localization,
  formatting,
  help
}) {
  const presenter = createRuntimePanelPresenter({
    settings,
    state,
    threadCache,
    chats,
    queue,
    status,
    models,
    views,
    localization,
    formatting
  });
  const { resolvePanel } = createRuntimePanelResolver({
    queue,
    status,
    models,
    keyboards,
    chats,
    localization,
    formatting,
    help,
    presenter
  });

  async function sendPanel(ctx, panel, options = {}) {
    const chatKey = telegram.getChatKey(ctx);
    const { html, keyboard: panelKeyboard } = await resolvePanel(ctx, panel, chatKey);
    const keyboard = keyboards.withClose(
      keyboards.withPrevious(panelKeyboard, keyboards.previousPanelFor(panel))
    );
    if (options.edit === true) return telegram.editOrReplyHtml(ctx, html, keyboard);
    return telegram.replyHtml(ctx, html, keyboard);
  }

  return {
    fastPanelHtml: presenter.fastPanelHtml,
    runtimePanelHtml: presenter.runtimePanelHtml,
    sendPanel,
    settingsPanelHtml: presenter.settingsPanelHtml
  };
}
