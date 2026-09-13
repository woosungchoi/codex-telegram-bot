export const STATE_SCHEMA_VERSION = 1;

function record(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid saved state: ${path} must be an object.`);
  }
  return value;
}

function version(value, key, path) {
  const current = value[key] ?? 0;
  if (
    !Number.isInteger(current) ||
    current < 0 ||
    current > STATE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported saved state version at ${path}.${key}: ${current}`,
    );
  }
}

function recordMap(value, path) {
  record(value, path);
  for (const [key, item] of Object.entries(value))
    record(item, `${path}.${key}`);
}

function namespace(value, path, fields) {
  const input = value === undefined ? {} : record(value, path);
  version(input, "version", path);
  for (const key of fields) {
    if (input[key] !== undefined) record(input[key], `${path}.${key}`);
  }
  if (
    input.version === STATE_SCHEMA_VERSION &&
    fields.every((key) => input[key] !== undefined)
  )
    return input;
  return {
    ...input,
    version: STATE_SCHEMA_VERSION,
    ...Object.fromEntries(fields.map((key) => [key, input[key] ?? {}])),
  };
}

export function normalizeWorkspaceState(
  value,
  { validateRecords = true } = {},
) {
  const result = namespace(value, "workspace", [
    "projects",
    "tasks",
    "flows",
    "panels",
    "panelPreferences",
  ]);
  if (!validateRecords) return result;
  for (const [key, projects] of Object.entries(result.projects)) {
    if (!Array.isArray(projects))
      throw new Error(
        `Invalid saved state: workspace.projects.${key} must be an array.`,
      );
    for (const project of projects)
      record(project, `workspace.projects.${key}[]`);
  }
  for (const key of ["tasks", "flows", "panels"])
    recordMap(result[key], `workspace.${key}`);
  for (const enabled of Object.values(result.panelPreferences)) {
    if (typeof enabled !== "boolean")
      throw new Error(
        "Invalid saved state: workspace.panelPreferences values must be boolean.",
      );
  }
  return result;
}

export function normalizeForumState(value, { validateRecords = true } = {}) {
  const result = namespace(value, "forum", ["groups", "jobs"]);
  if (!validateRecords) return result;
  recordMap(result.groups, "forum.groups");
  recordMap(result.jobs, "forum.jobs");
  for (const group of Object.values(result.groups)) {
    if (group.topics !== undefined)
      recordMap(group.topics, "forum.groups[].topics");
  }
  return result;
}

function liveFlows(flows, now) {
  // UI prompts expire; durable tasks, delivery ledgers and reset attempts do not.
  return Object.fromEntries(
    Object.entries(flows).filter(
      ([, flow]) => !(Number.isFinite(flow.expiresAt) && flow.expiresAt <= now),
    ),
  );
}

export function migrateRuntimeState(value, { now = Date.now() } = {}) {
  const input = record(value, "state");
  version(input, "schemaVersion", "state");
  for (const key of [
    "ui",
    "runtime",
    "chats",
    "queues",
    "cleanup",
    "uploadCleanup",
    "maintenance",
    "worker",
    "snapshots",
  ]) {
    if (input[key] !== undefined) record(input[key], key);
  }
  for (const key of ["accountUi", "accountResetAttempts"]) {
    if (input[key] !== undefined) recordMap(input[key], key);
  }
  for (const [owner, key] of [
    ["cleanup", "plans"],
    ["uploadCleanup", "plans"],
    ["worker", "deliveries"],
  ]) {
    if (input[owner]?.[key] !== undefined)
      record(input[owner][key], `${owner}.${key}`);
  }
  const workspace = normalizeWorkspaceState(input.workspace);
  const forum = normalizeForumState(input.forum);
  return {
    ...input,
    schemaVersion: STATE_SCHEMA_VERSION,
    workspace: { ...workspace, flows: liveFlows(workspace.flows, now) },
    forum,
    ...(input.accountUi === undefined
      ? {}
      : { accountUi: liveFlows(input.accountUi, now) }),
  };
}

// Reads validate only namespace/version/container shape. Full record validation
// stays at load and save boundaries, including direct controller mutations.
export function validateMutableNamespaces(state) {
  normalizeWorkspaceState(state.workspace);
  normalizeForumState(state.forum);
}
