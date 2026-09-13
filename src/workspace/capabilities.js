// @ts-check
/** @param {import("./contracts.js").WorkspaceRuntime} runtime
 *  @returns {import("./contracts.js").WorkspaceCapabilities} */
export function createWorkspaceCapabilities(runtime) {
  return {
    chats: {
      key: runtime.getChatKey,
      get: runtime.getChatState,
      options: runtime.getEffectiveOptions,
      cache: runtime.threadCache,
      get all() {
        return runtime.state.chats || {};
      },
    },
    execution: {
      active: runtime.activeTurns,
      pending: runtime.getPendingTurns,
      sideCount: runtime.getSideTurnCount,
      pendingDelivery: runtime.hasPendingFinalDelivery,
      cancel: runtime.cancelWorkerJobOnce,
    },
    settings: {
      config: runtime.config,
      get ui() {
        return runtime.state.ui || {};
      },
    },
    telegram: { bot: runtime.bot },
  };
}
