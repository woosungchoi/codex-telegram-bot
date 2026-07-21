import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  renderHandoffMarkdown,
  sanitizeHandoffFilename,
  sessionHighlightFromItem
} from "../handoff.js";
import { b, code } from "../telegram/html.js";
import { parseCodexMaintenanceOutput } from "./codex.js";

const execFileAsync = promisify(execFile);

export function createCodexMaintenanceController({
  settings,
  state,
  threadCache,
  chats,
  sessions,
  localization,
  formatting,
  runProcess = execFileAsync,
  now = () => new Date()
}) {
  function menuHtml() {
    return [
      b(localization.text("codexMaintenance")),
      b(localization.text("codexMaintenance")),
      "",
      localization.text("maintenanceIntro"),
      localization.text("maintenanceScope"),
      `${localization.text("autoSqliteRepair")}: ${code(autoSqliteRepairEnabled() ? "on" : "off")}`,
      `${localization.text("autoHandoff")}: ${code(autoHandoffEnabled() ? "on" : "off")}`,
      "",
      `- Report: ${localization.text("maintenanceReportDesc")}`,
      `- Backup: ${localization.text("maintenanceBackupDesc")}`,
      `- Config prune: ${localization.text("maintenanceConfigDesc")}`,
      `- Worktrees: ${localization.text("maintenanceWorktreesDesc")}`,
      `- Logs: ${localization.text("maintenanceLogsDesc")}`,
      `- SQLite repair: ${localization.text("maintenanceRepairDesc")}`,
      `- Handoff: ${localization.text("maintenanceHandoffDesc")}`
    ].join("\n");
  }

  function sqliteRepairConfirmHtml() {
    const config = settings.config;
    return [
      b(localization.text("sqliteConfirmTitle")),
      "",
      localization.text("sqliteConfirmBody"),
      `title limit: ${code(config.codexMaintenanceThreadTitleLimit)}`,
      `preview limit: ${code(config.codexMaintenanceThreadPreviewLimit)}`,
      "",
      `- ${localization.text("sqliteNoTranscript")}`,
      `- ${localization.text("sqliteRestore")}`,
      `- ${localization.text("sqliteAutoOff")}`,
      "",
      localization.text("sqliteContinue")
    ].join("\n");
  }

  function autoSqliteRepairEnabled() {
    return state.maintenance?.autoSqliteRepairEnabled === true;
  }

  function autoHandoffEnabled() {
    return state.maintenance?.autoHandoffEnabled === true;
  }

  async function readReport() {
    return run("report");
  }

  async function run(action) {
    const config = settings.config;
    const args = [
      config.codexMaintenanceScript,
      action,
      "--codex-home",
      config.codexHome,
      "--worktree-older-than-days",
      String(config.codexMaintenanceWorktreeDays),
      "--rotate-logs-above-mb",
      String(config.codexMaintenanceLogRotateMb),
      "--thread-title-limit",
      String(config.codexMaintenanceThreadTitleLimit),
      "--thread-preview-limit",
      String(config.codexMaintenanceThreadPreviewLimit)
    ];
    if (action !== "report") {
      args.push(
        "--backup-root",
        path.join(
          config.codexMaintenanceBackupDir,
          `${formatting.localDateKey()}-${action}-${now().getTime()}`
        )
      );
    }
    const { stdout } = await runProcess("python3", args, {
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseCodexMaintenanceOutput(stdout);
  }

  function formatReport(report) {
    const config = settings.config;
    const sessionSummary = report.sessions || {};
    const archived = report.archivedSessions || {};
    const worktrees = report.worktrees || {};
    const stale = report.staleWorktrees || {};
    const logs = report.logs || {};
    const configPrune = report.configPrune || {};
    const metadata = report.metadataBloat || {};
    const nodeRows = Array.isArray(report.topNodeProcesses) ? report.topNodeProcesses : [];
    const lines = [
      b(localization.text("maintenanceReportTitle")),
      "",
      `codexHome: ${code(report.codexHome || config.codexHome)}`,
      `sessions: ${code(formatting.count(sessionSummary.files ?? 0))} / ${code(formatting.bytes(sessionSummary.bytes ?? 0))}`,
      `archived sessions: ${code(formatting.count(archived.files ?? 0))} / ${code(formatting.bytes(archived.bytes ?? 0))}`,
      `worktrees: ${code(formatting.count(worktrees.count ?? 0))} / ${code(formatting.bytes(worktrees.bytes ?? 0))}`,
      `stale worktrees: ${code(formatting.count(stale.candidates ?? 0))} / ${code(formatting.bytes(stale.bytes ?? 0))}`,
      `logs: ${code(formatting.bytes(logs.bytes ?? 0))} / rotate ${code(`${logs.rotateThresholdMb ?? config.codexMaintenanceLogRotateMb}MB`)}`,
      `${localization.text("cleanupMaintenanceConfigPruneCandidates")}: ${code(formatting.count(configPrune.candidates ?? 0))}`,
      `metadata bloat: title ${code(metadata.titlesOverLimit ?? 0)} / preview ${code(metadata.previewsOverLimit ?? 0)} / 10k+ ${code(metadata.previewsOver10k ?? 0)}`
    ];
    if (nodeRows.length > 0) {
      lines.push("", b(localization.text("nodeTop")));
      for (const item of nodeRows.slice(0, 3)) {
        lines.push(`- pid ${code(item.pid)} / ${code(`${item.mb}MB`)}`);
      }
    }
    return lines.join("\n");
  }

  function formatResult(result) {
    const config = settings.config;
    const lines = [
      b(`${localization.text("maintenanceDone")}: ${result.action || "unknown"}`),
      "",
      `backupRoot: ${code(result.backupRoot || "none")}`,
      `backedUp: ${code(formatting.count(Array.isArray(result.backedUp) ? result.backedUp.length : 0))}`
    ];
    if (result.configPrune) {
      lines.push(
        `config prune: ${localization.text("maintenanceCandidates")}: ${code(result.configPrune.candidates)} / applied ${code(result.configPrune.applied)}`
      );
    }
    if (result.worktreeArchive) {
      lines.push(
        `worktrees: ${localization.text("maintenanceCandidates")}: ${code(result.worktreeArchive.candidates)} / moved ${code(result.worktreeArchive.moved)} / ${code(formatting.bytes(result.worktreeArchive.bytes || 0))}`,
        `manifest: ${code(result.worktreeArchive.manifest || "none")}`
      );
    }
    if (result.logRotate) {
      lines.push(
        `logs: files ${code(result.logRotate.files)} / rotated ${code(result.logRotate.rotated)} / ${code(formatting.bytes(result.logRotate.bytes || 0))}`
      );
      if (result.logRotate.skipped) lines.push(`skipped: ${code(result.logRotate.skipped)}`);
      if (result.logRotate.manifest) lines.push(`manifest: ${code(result.logRotate.manifest)}`);
    }
    if (result.sqliteMetadataRepair) {
      const repair = result.sqliteMetadataRepair;
      lines.push(
        `sqlite repair: ${localization.text("maintenanceCandidates")}: ${code(repair.candidates ?? 0)} / repaired ${code(repair.repaired ?? 0)}`,
        `limits: title ${code(repair.titleLimit ?? config.codexMaintenanceThreadTitleLimit)} / preview ${code(repair.previewLimit ?? config.codexMaintenanceThreadPreviewLimit)}`
      );
      if (repair.manifest) lines.push(`manifest: ${code(repair.manifest)}`);
      if (repair.restoreScript) lines.push(`restore: ${code(repair.restoreScript)}`);
      if (repair.reason) lines.push(`reason: ${code(repair.reason)}`);
    }
    return lines.join("\n");
  }

  async function createCurrentHandoff(chatKey) {
    const chat = chats.get(chatKey);
    const cached = threadCache.get(chatKey);
    const fallbackSession = chat.threadId || cached?.id
      ? null
      : (await sessions.listRecent(1))[0] ?? null;
    const threadId = chat.threadId || cached?.id || fallbackSession?.id || "";
    if (!threadId) throw new Error(localization.text("handoffNoThreadError"));
    return createThreadHandoff(threadId);
  }

  async function createThreadHandoff(threadId) {
    const sessionFile = await sessions.findFile(threadId);
    if (!sessionFile) {
      throw new Error(localization.formatText("handoffSessionFileNotFound", { threadId }));
    }
    const meta = await sessions.readMeta(sessionFile);
    const highlights = await readSessionHighlights(
      sessionFile,
      settings.config.codexHandoffRecentEvents
    );
    const targetDir = await resolveHandoffDir(meta?.cwd);
    await fs.mkdir(targetDir, { recursive: true });
    const projectName = (meta?.cwd || "codex").split(path.sep).filter(Boolean).pop() || "codex";
    const file = path.join(
      targetDir,
      `${formatting.localDateKey()}-${sanitizeHandoffFilename(projectName)}-${threadId.slice(0, 8)}.md`
    );
    const body = renderHandoffMarkdown({
      threadId,
      sessionFile,
      meta,
      highlights,
      generatedAt: now().toISOString()
    });
    await fs.writeFile(file, body, "utf8");
    return {
      ok: true,
      file,
      threadId,
      cwd: meta?.cwd || "",
      highlights: highlights.length
    };
  }

  async function resolveHandoffDir(cwd) {
    if (cwd && path.isAbsolute(cwd)) {
      try {
        const stat = await fs.stat(cwd);
        if (stat.isDirectory()) return path.join(cwd, "docs", "codex-handoffs");
      } catch {
        // Fall through to the configured handoff directory.
      }
    }
    return settings.config.codexHandoffDir;
  }

  async function readSessionHighlights(file, limit) {
    const highlights = [];
    const lines = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const highlight = sessionHighlightFromItem(item);
      if (!highlight) continue;
      highlights.push(highlight);
      while (highlights.length > limit) highlights.shift();
    }
    return highlights;
  }

  function formatHandoff(result) {
    return formatting.keyValue(localization.text("handoffResultTitle"), [
      ["thread", result.threadId],
      ["file", result.file],
      ["cwd", result.cwd || "unknown"],
      ["highlights", formatting.count(result.highlights)]
    ]);
  }

  return {
    autoHandoffEnabled,
    autoSqliteRepairEnabled,
    createCurrentHandoff,
    createThreadHandoff,
    formatHandoff,
    formatReport,
    formatResult,
    menuHtml,
    readReport,
    run,
    sqliteRepairConfirmHtml
  };
}
