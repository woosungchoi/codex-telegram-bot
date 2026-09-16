// Types at the controller boundary. Persisted records are normalized separately.
export type Operation = (...args: any[]) => any;
export type RecordMap = Record<string, any>;
export interface ChatAccess {
  key: Operation;
  get: Operation;
  options: Operation;
  cache: Map<string, any>;
  all: RecordMap;
}
export interface ExecutionAccess {
  active: Map<string, any>;
  pending: Operation;
  sideCount: Operation;
  pendingDelivery: Operation;
  cancel: Operation;
}
export interface WorkspaceCapabilities {
  chats: ChatAccess;
  execution: ExecutionAccess;
  settings: { config: RecordMap; ui: RecordMap };
  telegram: { bot: any };
}
export interface WorkspaceRuntime {
  getChatKey: Operation;
  getChatState: Operation;
  getEffectiveOptions: Operation;
  threadCache: Map<string, any>;
  activeTurns: Map<string, any>;
  getPendingTurns: Operation;
  getSideTurnCount: Operation;
  hasPendingFinalDelivery: Operation;
  cancelWorkerJobOnce: Operation;
  state: RecordMap;
  config: RecordMap;
  bot: any;
}
export interface WorkspaceUi {
  button: Operation;
  back: Operation;
  show: Operation;
  ask: Operation;
  clear: Operation;
  close: Operation;
}
export interface AccountAccess {
  get: Operation;
  list: Operation;
  acquire: Operation;
}
export interface WorkspaceBackend {
  listSessions: Operation;
  readSession: Operation;
  readMcp: Operation;
  setMcpEnabled: Operation;
}
export interface Scheduler {
  reconcile: Operation;
  run: Operation;
  stopRun: Operation;
  busy: Operation;
}
export interface WorkspaceState {
  projects: RecordMap;
  tasks: RecordMap;
  flows: RecordMap;
  panels: RecordMap;
  panelPreferences: RecordMap;
}

export interface ProjectsServices {
  accounts: AccountAccess;
  assertIdle: Operation;
  browse: Operation;
  btn: Operation;
  chats: ChatAccess;
  currentPreset: Operation;
  nav: Operation;
  now: () => number;
  project: Operation;
  projects: Operation;
  readyAccount: Operation;
  resetThread: Operation;
  state: WorkspaceState;
  t: (key: string) => string;
  ui: WorkspaceUi;
  validateDirectory: Operation;
}

export interface SessionsServices {
  accounts: AccountAccess;
  assertIdle: Operation;
  backend: WorkspaceBackend;
  btn: Operation;
  chats: ChatAccess;
  currentAccount: Operation;
  date: Operation;
  execution: ExecutionAccess;
  nav: Operation;
  now: () => number;
  readTail: Operation;
  readyAccount: Operation;
  safe: Operation;
  settings: WorkspaceCapabilities["settings"];
  state: WorkspaceState;
  t: (key: string) => string;
  telegram: WorkspaceCapabilities["telegram"];
  ui: WorkspaceUi;
  validateDirectory: Operation;
}

export interface TasksServices {
  accounts: AccountAccess;
  btn: Operation;
  chats: ChatAccess;
  currentPreset: Operation;
  date: Operation;
  meta: Operation;
  nav: Operation;
  now: () => number;
  projects: Operation;
  readyAccount: Operation;
  scheduler: Scheduler;
  settings: WorkspaceCapabilities["settings"];
  state: WorkspaceState;
  t: (key: string) => string;
  task: Operation;
  ui: WorkspaceUi;
  validateDirectory: Operation;
}

export interface McpServices {
  accounts: AccountAccess;
  assertAccountIdle: Operation;
  assertAdmin: Operation;
  backend: WorkspaceBackend;
  btn: Operation;
  chats: ChatAccess;
  currentAccount: Operation;
  safe: Operation;
  t: (key: string) => string;
  ui: WorkspaceUi;
}

export interface DashboardServices {
  btn: Operation;
  dashboard: { describe: Operation; activeFor: Operation; tick: Operation };
  execution: ExecutionAccess;
  meta: Operation;
  scheduler: Scheduler;
  state: WorkspaceState;
  t: (key: string) => string;
  ui: WorkspaceUi;
}
