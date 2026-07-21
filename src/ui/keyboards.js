import {
  createNavigationKeyboardViews,
  inlineKeyboard
} from "./keyboard_helpers.js";
import { createOperationsKeyboardViews } from "./operations_keyboards.js";
import {
  booleanOptionKeyboardRows,
  createSelectionKeyboardViews,
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
} from "./selection_keyboards.js";
import { createSettingsKeyboardViews } from "./settings_keyboards.js";

export {
  booleanOptionKeyboardRows,
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
};

export function createRuntimeKeyboardViews({
  text,
  hasActiveTurn,
  sideTurnCount,
  currentLanguage,
  currentTimeZone,
  currentLocale,
  isQueuePaused = () => false,
  pendingTurnsFor = () => [],
  maintenanceAutoHandoffEnabled = () => false,
  maintenanceAutoSqliteRepairEnabled = () => false
}) {
  const navigation = createNavigationKeyboardViews({ text });
  const selection = createSelectionKeyboardViews({
    text,
    withMenuCloseButton: navigation.withMenuCloseButton,
    withPreviousPanelButton: navigation.withPreviousPanelButton
  });
  const settings = createSettingsKeyboardViews({
    text,
    currentLanguage,
    currentTimeZone,
    currentLocale,
    withMenuCloseButton: navigation.withMenuCloseButton
  });
  const operations = createOperationsKeyboardViews({
    text,
    hasActiveTurn,
    sideTurnCount,
    isQueuePaused,
    pendingTurnsFor,
    maintenanceAutoHandoffEnabled,
    maintenanceAutoSqliteRepairEnabled,
    withMenuCloseButton: navigation.withMenuCloseButton
  });

  return {
    ...navigation,
    ...selection,
    ...settings,
    ...operations,
    inlineKeyboard
  };
}
