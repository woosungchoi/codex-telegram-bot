import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePhotoArtifactCandidates } from "../src/telegram/attachments.js";
async function photoFixture(t, caption) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photo-send-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "chart.png");
  await fs.writeFile(file, "png");
  return (await resolvePhotoArtifactCandidates([{ path: file, caption }], { allowedRoots: [root] })).photos[0];
}
import test from "node:test";
import assert from "node:assert/strict";
import { replyTelegramPhotos } from "../src/telegram/photo.js";

function createCtx() {
  const calls = [];
  return {
    chat: { id: -100123 },
    msg: { message_id: 77, is_topic_message: true, message_thread_id: 456 },
    async replyWithPhoto(photo, extra) {
      calls.push({ photo, extra });
      return { message_id: 1001 };
    },
    calls
  };
}

test("replyTelegramPhotos sends photo to the current topic thread", async (t) => {
  const ctx = createCtx();
  const photo = await photoFixture(t, "SPCX 차트");
  const sent = await replyTelegramPhotos(ctx, [photo]);

  assert.deepEqual(sent, [{ message_id: 1001 }]);
  assert.deepEqual(ctx.calls, [{
    photo: { source: Buffer.from("png"), filename: "chart.png" },
    extra: { caption: "SPCX 차트", message_thread_id: 456 }
  }]);
});

test("replyTelegramPhotos delegates upload failures to onError", async (t) => {
  const photo = await photoFixture(t);
  const error = new Error("upload failed");
  const handled = [];
  const ctx = {
    msg: {},
    async replyWithPhoto() {
      throw error;
    }
  };

  const sent = await replyTelegramPhotos(ctx, [photo], {
    onError: async (photo, caught) => handled.push({ photo, caught })
  });

  assert.deepEqual(sent, []);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].photo, photo);
  assert.equal(handled[0].caught, error);
});
