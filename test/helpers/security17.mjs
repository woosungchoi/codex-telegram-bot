import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureUpdateApproval } from "../../src/maintenance/update_approval.js";
import { signControlRecord } from "../../src/maintenance/control_receipt.js";
export const operatorCtx = { from: { id: 7 }, chat: { id: 7, type: "private" }, botInfo: { id: 12345 } };
export const operatorConfig = { allowedUserIds: new Set(["7", "8"]), operatorUserIds: new Set(["7"]), queueAdminUserIds: new Set(["7"]), telegramBotToken: "12345:fixture" };
export async function approveUpdate(config, state) {
  config.maintenanceControlDir ||= await fs.mkdtemp(path.join(os.tmpdir(), "control-fixture-"));
  const approval = await captureUpdateApproval(config, state.target);
  const id = `update-${state.id}`;
  await fs.rm(path.join(config.maintenanceControlDir, `${id}.json`), { force: true });
  await signControlRecord(config.maintenanceControlDir, id, { kind: "update-approval-v1", id: state.id, target: state.target, sdk: state.sdk, origin: state.origin, ...approval });
}
