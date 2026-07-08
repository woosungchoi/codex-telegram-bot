import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { collectCodexSkillInventory, formatCodexSkillInventory, replyCodexSkillsStatus } from "../src/codex/skills_status.js";
import { makeFixture, skillDoc, tempCodexHome, writeFile } from "./helpers/codex_skills_status_fixture.mjs";

test("collects local and manifest-declared plugin skills with narrow status parsing", async () => {
  const { codexHome } = await makeFixture();

  const inventory = await collectCodexSkillInventory({ codexHome });

  assert.equal(countStatus(inventory.skills, "local/system"), 1);
  assert.equal(countStatus(inventory.skills, "local/custom"), 2);
  assert.equal(countStatus(inventory.skills, "plugin enabled"), 1);
  assert.equal(countStatus(inventory.skills, "plugin cached"), 2);
  assert.equal(countStatus(inventory.skills, "plugin disabled"), 1);

  assert.ok(inventory.skills.some((skill) => skill.displayName === "custom-one"));
  assert.ok(inventory.skills.some((skill) => skill.displayName === "broken-frontmatter"));
  assert.ok(inventory.skills.some((skill) => skill.displayName === "Declared Skill"));
  assert.ok(!inventory.skills.some((skill) => skill.displayName === "Leaked Component Skill"));
  assert.ok(!inventory.skills.some((skill) => skill.displayName === "Nested Plugin Skill"));
  assert.ok(inventory.warnings.some((warning) => warning.message === "skill frontmatter ignored"));
  assert.ok(inventory.warnings.some((warning) => warning.message === "plugin manifest ignored"));
  assert.ok(inventory.warnings.some((warning) => warning.message === "Codex config plugin enabled value ignored"));
  assert.ok(inventory.warnings.some((warning) => warning.message === "Codex config plugin header ignored"));
});

test("formats compact escaped Telegram HTML without absolute path leakage", async () => {
  const { codexHome } = await makeFixture();
  const inventory = await collectCodexSkillInventory({ codexHome });

  const html = formatCodexSkillInventory(inventory, { maxChars: 760 });

  assert.match(html, /Codex skills/);
  assert.match(html, /observable install\/cache\/config state/);
  assert.match(html, /unique \d+ \/ scanned \d+/);
  assert.match(html, /Warnings: \d+ sanitized/);
  assert.doesNotMatch(html, /more omitted/);
  assert.ok(html.length <= 760);
  assert.ok(!html.includes(codexHome));
  assert.ok(!html.includes("<script>"));
  assert.doesNotMatch(html, /Use &lt;b&gt;bold&lt;\/b&gt;/);
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /&lt;Skill&gt; &amp; &quot;One&quot;/);
});

test("redacts untrusted skill metadata paths while escaping HTML", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-metadata-");
  await writeFile(
    path.join(codexHome, "skills", ".system", "adversarial", "SKILL.md"),
    skillDoc("name: adversarial", "description: equals=/etc/passwd colon:/tmp/top-secret comma,/home/openclaw/path url=file:///var/secret filehost=file://localhost/etc/file-host-secret fileuser=file://user@localhost/etc/user-secret unicode=/tmp/비밀/secret punct=/tmp/top-secret.v1/config.json trailing=/tmp/trailing-secret, space=/tmp/path with spaces/secret extra_filehost=file://localhost/var/lib/app secret/config <script>alert(\"x\")</script> normalword semi;/etc/passwd pipe|/tmp/top-secret query?/home/openclaw/path amp&/var/secret dot./opt/secret <script>alert(\"x\")</script>")
  );

  const inventory = await collectCodexSkillInventory({ codexHome });
  const html = formatCodexSkillInventory(inventory, { maxChars: 1000, query: "adversarial" });

  assert.match(html, /equals=\[path\][\s\S]*colon:\[path\][\s\S]*comma,\[path\][\s\S]*url=file:\/\/\[path\][\s\S]*&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /filehost=file:\/\/localhost\[path\][\s\S]*fileuser=file:\/\/user@localhost\[path\][\s\S]*unicode=\[path\][\s\S]*punct=\[path\][\s\S]*trailing=\[path\],/);
  assert.match(html, /normalword semi;\[path\][\s\S]*pipe\|\[path\][\s\S]*query\?\[path\][\s\S]*amp&amp;\[path\][\s\S]*dot\.\[path\]/);
  assert.doesNotMatch(html, /<script>|file:\/\/localhost\/var\/lib\/app secret\/config|secret\/config|\/etc\/passwd|\/tmp\/top-secret|\/tmp\/path with spaces\/secret|with spaces\/secret|\/home\/openclaw\/path|\/var\/secret|\/opt\/secret|\/etc\/file-host-secret|\/etc\/user-secret|\/tmp\/비밀\/secret|\/tmp\/top-secret\.v1\/config\.json|\/tmp\/trailing-secret/);
});

test("plugin skills root symlinks cannot escape the plugin root", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-symlink-");
  const pluginRoot = path.join(codexHome, "plugins", "cache", "marketplace", "symlinked", "1.0.0");
  const outsideRoot = path.join(codexHome, "outside-plugin-skills");
  await Promise.all([
    writeFile(path.join(codexHome, "config.toml"), ""),
    writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "symlinked", skills: "./skills" })
    ),
    writeFile(
      path.join(outsideRoot, "escaped", "SKILL.md"),
      skillDoc("name: Symlink Escaped Skill", "description: raw /home/openclaw/path <script>")
    )
  ]);
  await fs.symlink(outsideRoot, path.join(pluginRoot, "skills"));

  const inventory = await collectCodexSkillInventory({ codexHome });
  const html = formatCodexSkillInventory(inventory, { maxChars: 1000 });

  assert.ok(!inventory.skills.some((skill) => skill.displayName === "Symlink Escaped Skill"));
  assert.match(html, /Warnings: \d+ sanitized/);
  assert.doesNotMatch(html, /Symlink Escaped Skill|\/home\/openclaw\/path|<script>/);
});

test("parses quoted scalar frontmatter and ignores nested unknown metadata", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-frontmatter-");
  await writeFile(
    path.join(codexHome, "skills", ".system", "quoted", "SKILL.md"),
    skillDoc('name: "quoted-name"', `description: 'quoted <desc> & "prompt"'`)
  );
  await writeFile(
    path.join(codexHome, "skills", ".system", "nested", "SKILL.md"),
    skillDoc("metadata:", "  short-description: okay", "unknown:", "  deeper: ignored", "name: nested-ok", 'description: "nested <desc> & prompt"')
  );

  const inventory = await collectCodexSkillInventory({ codexHome });
  const quoted = inventory.skills.find((skill) => skill.displayName === "quoted-name");
  const nested = inventory.skills.find((skill) => skill.displayName === "nested-ok");

  assert.equal(quoted?.description, `quoted <desc> & "prompt"`);
  assert.equal(nested?.description, "nested <desc> & prompt");
  assert.ok(!inventory.skills.some((skill) => skill.displayName.includes('"') || skill.displayName.includes("'")));
  assert.ok(!inventory.warnings.some((warning) => warning.message === "skill frontmatter ignored"));
});

test("missing roots become sanitized warnings and no raw paths or exceptions are formatted", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-missing-");

  const inventory = await collectCodexSkillInventory({ codexHome });
  const html = formatCodexSkillInventory(inventory, { maxChars: 1000 });

  assert.equal(inventory.skills.length, 0);
  assert.ok(inventory.warnings.some((warning) => warning.message === "Codex config unavailable"));
  assert.match(html, /Warnings: \d+ sanitized/);
  assert.ok(!html.includes(codexHome));
  assert.ok(!html.includes("ENOENT"));
});

test("replies with capped skills status when edit mode is not requested", async () => {
  const { codexHome } = await makeFixture();
  const calls = { reply: [], edit: [], runtimeKeys: [] };
  const deps = {
    config: { codexHome },
    runtimeValue(key) {
      calls.runtimeKeys.push(key);
      return key === "maxTelegramChars" ? 760 : undefined;
    },
    async replyHtml(ctx, html, extra) {
      calls.reply.push({ ctx, html, extra });
      return { message_id: 11 };
    },
    async editOrReplyHtml(ctx, html, extra) {
      calls.edit.push({ ctx, html, extra });
      return { message_id: 12 };
    }
  };
  const ctx = { chat: { id: 1 } };

  const result = await replyCodexSkillsStatus(ctx, deps);

  assert.deepEqual(result, { message_id: 11 });
  assert.deepEqual(calls.runtimeKeys, ["maxTelegramChars"]);
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.edit.length, 0);
  assert.equal(calls.reply[0].ctx, ctx);
  assert.ok(calls.reply[0].extra?.reply_markup?.inline_keyboard);
  assert.match(calls.reply[0].html, /Codex skills/);
  assert.doesNotMatch(calls.reply[0].html, /more omitted/);
  assert.ok(calls.reply[0].html.length <= 760);
  assert.ok(collectCallbackData(calls.reply[0].extra).every((value) => Buffer.byteLength(value) <= 64));
});

test("edits with supplied keyboard when edit mode is requested", async () => {
  const { codexHome } = await makeFixture();
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: "Tools", callback_data: "p:tools" }]] } };
  const calls = { reply: [], edit: [] };
  const deps = {
    config: { codexHome },
    runtimeValue: (key) => (key === "maxTelegramChars" ? 4000 : undefined),
    async replyHtml(ctx, html, extra) {
      calls.reply.push({ ctx, html, extra });
      return { message_id: 21 };
    },
    async editOrReplyHtml(ctx, html, extra) {
      calls.edit.push({ ctx, html, extra });
      return { message_id: 22 };
    }
  };

  const result = await replyCodexSkillsStatus({ callbackQuery: { message: { chat: { id: 1 } } } }, deps, { edit: true, extra: keyboard });

  assert.deepEqual(result, { message_id: 22 });
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.edit.length, 1);
  assert.ok(collectCallbackData(calls.edit[0].extra).includes("p:tools"));
  assert.ok(collectCallbackData(calls.edit[0].extra).includes("sk:w:0"));
  assert.match(calls.edit[0].html, /Codex skills/);
});

test("does not depend on src runtime imports", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "codex", "skills_status.js"), "utf8");

  assert.doesNotMatch(source, /runtime\.js|from\s+["'][^"']*runtime["']/);
});

test("sanitizes collection failures into warning output", async () => {
  const calls = [];
  const deps = {
    config: { codexHome: { invalid: true } },
    runtimeValue: (key) => (key === "maxTelegramChars" ? 1000 : undefined),
    async replyHtml(_ctx, html, extra) {
      calls.push({ html, extra });
      return { message_id: 31 };
    },
    async editOrReplyHtml() {
      throw new Error("edit should not be used");
    }
  };

  const result = await replyCodexSkillsStatus({ chat: { id: 1 } }, deps);

  assert.deepEqual(result, { message_id: 31 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].html, /Codex skills/);
  assert.match(calls[0].html, /Warnings: 1 sanitized/);
  assert.doesNotMatch(calls[0].html, /TypeError|invalid|\/home\/|codex-skills-status/);
});

function countStatus(skills, status) { return skills.filter((skill) => skill.status === status).length; }

function collectCallbackData(extra) {
  return (extra?.reply_markup?.inline_keyboard || []).flat().map((button) => button.callback_data).filter(Boolean);
}
