import path from "node:path";

export function workerPaths(config = {}) {
  const stateDir = config.codexWorkerStateDir || path.join(process.cwd(), "state", "worker");
  return {
    stateDir,
    socket: config.codexWorkerSocket || path.join(stateDir, "worker.sock"),
    jobsDir: path.join(stateDir, "jobs"),
    archivesDir: path.join(stateDir, "archives"),
    eventsDir: path.join(stateDir, "events"),
    activeJobs: path.join(stateDir, "active-jobs.json"),
    corruptDir: path.join(stateDir, "corrupt")
  };
}
