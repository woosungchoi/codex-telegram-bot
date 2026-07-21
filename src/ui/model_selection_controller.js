import { createSettingsModelSelectionController } from "./settings_model_selection_controller.js";
import { createStandaloneModelSelectionController } from "./standalone_model_selection_controller.js";

export function createAtomicChatOptionsReplacer({
  getChat,
  save,
  invalidate,
  now = () => new Date().toISOString()
}) {
  return async function replaceChatOptions(chatKey, nextOptions) {
    const chat = getChat(chatKey);
    const previousOptions = chat.options;
    const previousUpdatedAt = chat.updatedAt;
    chat.options = nextOptions;
    chat.updatedAt = now();
    try {
      await save();
    } catch (error) {
      chat.options = previousOptions;
      chat.updatedAt = previousUpdatedAt;
      throw error;
    }
    invalidate(chatKey);
  };
}

export function createModelSelectionController({
  flowStore,
  models,
  chat,
  telegram,
  views,
  text
}) {
  const standalone = createStandaloneModelSelectionController({
    flowStore,
    models,
    chat,
    telegram,
    views,
    text
  });
  const settings = createSettingsModelSelectionController({
    models,
    chat,
    telegram,
    views,
    text
  });

  return {
    handleMenuClose: standalone.handleMenuClose,
    handleSettingsModelSelection: settings.handleSettingsModelSelection,
    handleSettingsReasoningSelection: settings.handleSettingsReasoningSelection,
    handleStandaloneFastSelection: standalone.handleStandaloneFastSelection,
    handleStandaloneModelSelection: standalone.handleStandaloneModelSelection,
    handleStandaloneReasoningSelection: standalone.handleStandaloneReasoningSelection,
    handleStandaloneSelectionCancel: standalone.handleStandaloneSelectionCancel,
    sendStandaloneModelSelection: standalone.sendStandaloneModelSelection,
    sendStandaloneReasoningSelection: standalone.sendStandaloneReasoningSelection
  };
}
