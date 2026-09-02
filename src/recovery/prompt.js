export function buildRecoveryPrompt(candidate, options = {}) {
  const serviceName = options.serviceName || "codex-telegram-bot.service";
  const restartSubject = options.restartSubject || "codex-telegram-bot";
  const workdir = options.workingDirectory || "";
  return [
    "<system_recovery_instruction>",
    `${restartSubject} restarted while the previous Telegram Codex turn was active.`,
    "You are running automatically after restart in the same Codex thread.",
    "",
    "Do not blindly re-run unfinished tool calls.",
    "First inspect the current repository, git status, service status, and any relevant test/log output.",
    "Infer what completed before restart from the conversation history and current filesystem state.",
    "Continue the user's original task from the safest correct point.",
    "If duplicate execution could be destructive, stop and report the uncertainty instead of guessing.",
    "",
    "Recovery metadata:",
    `- chatKey: ${candidate.chatKey}`,
    `- threadId: ${candidate.threadId || "unknown"}`,
    `- reason: ${candidate.reason || "unknown"}`,
    `- interrupted queue item: ${candidate.queueItemId || "unknown"}`,
    candidate.inputPreview ? `- original request preview: ${candidate.inputPreview}` : "- original request preview: unavailable",
    workdir ? `- working directory: ${workdir}` : "",
    "",
    "Required first checks when relevant:",
    "- git status --short --branch",
    `- systemctl --user is-active ${serviceName}`,
    `- journalctl --user -u ${serviceName} -n 100 --no-pager`,
    "- targeted tests for files touched by the interrupted task",
    "",
    "After recovery, report what was resumed, what was verified, and any remaining risk.",
    "</system_recovery_instruction>"
  ].filter(Boolean).join("\n");
}
