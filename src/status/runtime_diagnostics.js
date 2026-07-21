import { createRuntimeDiagnosticsCollectors } from "./runtime_diagnostics_collectors.js";
import { createRuntimeDiagnosticsPresenter } from "./runtime_diagnostics_presenter.js";

export {
  readCommandOutput,
  readJsonFile,
  readPackageJson
} from "./runtime_diagnostics_collectors.js";

export function createRuntimeDiagnostics({
  settings,
  state,
  activeTurns,
  threadCache,
  chats,
  options,
  queue,
  sessions,
  usage,
  models,
  uploads,
  localization,
  formatting,
  packages,
  now = Date.now
}) {
  const collectors = createRuntimeDiagnosticsCollectors({
    settings,
    state,
    activeTurns,
    threadCache,
    chats,
    options,
    queue,
    sessions,
    usage,
    models,
    uploads,
    localization,
    formatting,
    packages
  });
  const presenter = createRuntimeDiagnosticsPresenter({
    settings,
    state,
    activeTurns,
    queue,
    options,
    localization,
    formatting,
    now
  });

  async function formatRecoveryStatusHtml() {
    return formatting.keyValue(
      localization.text("recoveryStatusTitle"),
      await collectors.collectRecoveryStatusRows()
    );
  }

  async function formatDoctorHtml(chatKey) {
    return formatting.keyValue("Codex doctor:", await collectors.collectDoctorRows(chatKey));
  }

  async function formatHealthHtml() {
    return formatting.keyValue("Bot health:", await collectors.collectHealthRows());
  }

  return {
    buildStatusDetails: collectors.buildStatusDetails,
    formatDoctorHtml,
    formatHealthHtml,
    formatPendingDeliveryLines: presenter.formatPendingDeliveryLines,
    formatQueueHtml: presenter.formatQueueHtml,
    formatQueueModeHtml: presenter.formatQueueModeHtml,
    formatRecoveryStatusHtml,
    formatRestartRecoveredHtml: presenter.formatRestartRecoveredHtml,
    formatRestartScheduledHtml: presenter.formatRestartScheduledHtml,
    formatStatusHtml: presenter.formatStatusHtml
  };
}
