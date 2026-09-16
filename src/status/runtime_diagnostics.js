import { createMessageFormatter } from "../i18n.js";
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
  const msg = createMessageFormatter(localization.text);
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
    return formatting.keyValue(msg("ui.codexDoctor"), await collectors.collectDoctorRows(chatKey));
  }

  async function formatHealthHtml() {
    return formatting.keyValue(msg("ui.botHealth"), await collectors.collectHealthRows());
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
