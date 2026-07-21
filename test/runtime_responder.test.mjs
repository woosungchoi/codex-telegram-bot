import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramRuntimeResponder } from "../src/telegram/runtime_responder.js";

function createResponder() {
  return createTelegramRuntimeResponder({
    bot: { telegram: {} },
    settings: { runtimeValue: () => true },
    localization: { text: (key) => key }
  });
}

test("runtime responder tracks and deletes progress message references", async () => {
  const responder = createResponder();
  const deleted = [];
  const ctx = {
    chat: { id: 1 },
    telegram: { deleteMessage: async (...args) => deleted.push(args) }
  };
  const progress = { messageRefs: [] };
  responder.trackProgressMessage(ctx, progress, { message_id: 2 });
  await responder.deleteTrackedProgressMessages(ctx, progress);
  assert.deepEqual(deleted, [[1, 2]]);
  assert.deepEqual(progress.messageRefs, []);
});

test("runtime responder help keeps the panel-first command guidance", () => {
  const html = createResponder().helpTextHtml();
  assert.match(html, /\/menu/);
  assert.match(html, /\/settings/);
  assert.match(html, /\/tools/);
});
