import { createHash } from "node:crypto";
import { approvedArtifact } from "./update_artifact.js";
import { controlDir, readControlRecord, signControlRecord, requireControlSeparation } from "./control_receipt.js";

export function updateConfigDigest(config) {
  const values = Object.keys(config).filter((key) => key.startsWith("codexUpdate") || ["codexWorkerMode", "codexPath"].includes(key)).sort()
    .map((key) => [key, config[key] instanceof Set ? [...config[key]].sort() : config[key]]);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export async function captureUpdateApproval(config, target) {
  return { artifact: await approvedArtifact(config, target), configDigest: updateConfigDigest(config) };
}
export async function persistUpdateApproval(config, state) {
  const directory = controlDir(config);
  await requireControlSeparation(directory, [config.codexWorkdir, ...(config.codexAdditionalDirectories || []), config.codexUpdateAppRoot]);
  const current = await captureUpdateApproval(config, state.target);
  if (JSON.stringify(current) !== JSON.stringify(state.approval)) throw new Error("Update approval changed after preview.");
  await signControlRecord(directory, `update-${state.id}`, { kind: "update-approval-v1", id: state.id, target: state.target, sdk: state.sdk, origin: state.origin, ...current });
}
export async function verifyUpdateApproval(config, state) {
  const currentArtifact = await approvedArtifact(config, state.target);
  const approved = await readControlRecord(controlDir(config), `update-${state.id}`);
  if (approved.kind !== "update-approval-v1" || approved.id !== state.id || approved.target !== state.target
    || approved.configDigest !== updateConfigDigest(config)
    || JSON.stringify(approved.sdk) !== JSON.stringify(state.sdk)
    || JSON.stringify(approved.origin) !== JSON.stringify(state.origin)
    || JSON.stringify(approved.artifact) !== JSON.stringify(currentArtifact)) throw new Error("Detached update differs from the operator approval.");
  return approved;
}
