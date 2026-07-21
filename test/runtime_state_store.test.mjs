import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeSettingsController,
  normalizeRuntimeState,
  setRuntimeValue
} from "../src/runtime/state_store.js";

const defaults = {
  telegramLanguage: "en",
  telegramTimeZone: "UTC",
  telegramLocale: "en-US",
  codexMaintenanceAutoSqliteRepairEnabled: true,
  codexMaintenanceAutoHandoffEnabled: false,
  codexTransport: "sdk",
  codexWorkerMode: "inline"
};

const normalizers = {
  defaults,
  parseLanguage: String,
  parseTimeZone: String,
  parseLocale: String
};

test("runtime state normalization preserves known data and rejects stale overrides", () => {
  const state = normalizeRuntimeState({
    ui: { language: "ko" },
    runtime: {
      telegramPendingTurnsMax: "4",
      telegramLiveProgressIntervalMs: "3",
      removedSetting: "stale"
    },
    chats: { one: { options: {} } },
    worker: { deliveries: { job: { status: "ready" } } }
  }, normalizers);

  assert.equal(state.ui.language, "ko");
  assert.equal(state.ui.timeZone, "UTC");
  assert.deepEqual(state.runtime, {
    telegramPendingTurnsMax: 4,
    telegramLiveProgressIntervalMs: 3000
  });
  assert.ok(state.chats.one);
  assert.ok(state.worker.deliveries.job);
  assert.deepEqual(state.cleanup.plans, {});
});

test("runtime settings persist values and clear thread cache only for transport changes", async () => {
  const state = { runtime: {} };
  const threadCache = new Map([["chat", {}]]);
  let saves = 0;
  const settings = createRuntimeSettingsController({
    state,
    defaults,
    threadCache,
    save: async () => { saves += 1; }
  });

  await settings.updateRuntimeSetting("telegramPendingTurnsMax", "8");
  assert.equal(settings.runtimeValue("telegramPendingTurnsMax"), 8);
  assert.equal(threadCache.size, 1);

  await settings.updateRuntimeSetting("codexTransport", "app-server-direct");
  assert.equal(settings.runtimeValue("codexTransport"), "app-server-direct");
  assert.equal(threadCache.size, 0);
  assert.equal(saves, 2);
});

test("runtime setting validation supports defaults and rejects invalid values", () => {
  const target = { cleanupEnabled: true };
  setRuntimeValue(target, "cleanupEnabled", "default");
  assert.deepEqual(target, {});
  assert.throws(
    () => setRuntimeValue(target, "cleanupNotifyTime", "25:00"),
    /Time must use HH:MM/
  );
  assert.throws(
    () => setRuntimeValue(target, "unknown", "1"),
    /Unknown runtime setting/
  );
});
