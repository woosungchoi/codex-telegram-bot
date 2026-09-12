import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { telegramContextMeta, telegramTopicId } from "../telegram/context.js";

export const newId = () => randomBytes(8).toString("hex");
export const topicId = (ctx) => telegramContextMeta(ctx).messageThreadId;
export const scopeKey = (ctx) => `${ctx.chat.id}:${topicId(ctx) || 0}:${ctx.from.id}`;
export const destinationKey = (meta) => `${meta.chatId}:${telegramTopicId(meta) || 0}`;

export function workspaceState(state) {
  state.workspace ||= {};
  for (const key of ["projects", "tasks", "flows", "panels", "panelPreferences"]) state.workspace[key] ||= {};
  return state.workspace;
}

export function cleanName(value) {
  const name = String(value || "").replace(/\p{Cc}/gu, "").trim();
  if (!name || name.length > 48) throw new Error("Use a name containing 1–48 characters.");
  return name;
}

export async function directory(value) {
  let target = String(value || "").trim();
  if (target === "~") target = os.homedir();
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) throw new Error("Enter an absolute folder path.");
  const real = await fs.realpath(target);
  if (!(await fs.stat(real)).isDirectory()) throw new Error("The selected path is not a folder.");
  return real;
}

export async function browseFolders(value) {
  const cwd = await directory(value);
  const entries = await fs.readdir(cwd, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name));
  return { cwd, parent: path.dirname(cwd), folders: folders.slice(0, 250).map((e) => ({ name: e.name, cwd: path.join(cwd, e.name) })), capped: folders.length > 250 };
}

export function projectOptions(options) {
  return Object.fromEntries(["workingDirectory", "model", "modelReasoningEffort", "serviceTier"]
    .filter((key) => options[key] != null).map((key) => [key, options[key]]));
}

export function sortedProjects(projects, query = "") {
  const needle = query.trim().toLocaleLowerCase();
  return projects.filter((p) => !needle || `${p.name} ${p.cwd}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.name.localeCompare(b.name));
}
