// Dotted config keys are resolved by app-server for both start and resume.
export function nativeSessionConfig(options) {
  return {
    ...options.codexConfig,
    ...(options.modelReasoningEffort ? { model_reasoning_effort: options.modelReasoningEffort } : {}),
    ...(options.webSearchEnabled === false ? { web_search: "disabled" } : options.webSearchMode ? { web_search: options.webSearchMode }
      : typeof options.webSearchEnabled === "boolean" ? { web_search: options.webSearchEnabled ? "live" : "disabled" } : {}),
    ...(typeof options.networkAccessEnabled === "boolean" ? { "sandbox_workspace_write.network_access": options.networkAccessEnabled } : {}),
    ...(Array.isArray(options.additionalDirectories) ? { "sandbox_workspace_write.writable_roots": options.additionalDirectories } : {})
  };
}

// Start from the server-resolved policy so omitted settings remain untouched.
export function nativeTurnSandbox(options, sandbox) {
  if (!sandbox || !["workspaceWrite", "readOnly"].includes(sandbox.type)) {
    if (options.networkAccessEnabled === false) throw new Error("Resolved sandbox cannot enforce disabled network access.");
    return undefined;
  }
  if (typeof options.networkAccessEnabled !== "boolean" && !Array.isArray(options.additionalDirectories)) return undefined;
  return { ...sandbox,
    ...(typeof options.networkAccessEnabled === "boolean" ? { networkAccess: options.networkAccessEnabled } : {}),
    ...(sandbox.type === "workspaceWrite" && Array.isArray(options.additionalDirectories)
      ? { writableRoots: [...new Set([options.workingDirectory, ...options.additionalDirectories].filter(Boolean))] } : {})
  };
}
