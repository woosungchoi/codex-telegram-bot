import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectCodexSkillInventory, formatCodexSkillInventory, replyCodexSkillsStatus } from "../src/codex/skills_status.js";

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

function skillDoc(...frontmatter) { return ["---", ...frontmatter, "---", "Body"].join("\n"); }

async function tempCodexHome(prefix) { return path.join(await fs.mkdtemp(path.join(os.tmpdir(), prefix)), "codex-home"); }

async function makeFixture() {
  const codexHome = await tempCodexHome("codex-skills-status-");

  await writeFile(
    path.join(codexHome, "skills", ".system", "system-one", "SKILL.md"),
    skillDoc(`name: System <Skill> & "One"`, `description: Use <b>bold</b> & "quotes".`)
  );
  await writeFile(
    path.join(codexHome, "skills", "custom-one", "SKILL.md"),
    skillDoc("description: Custom skill without name.")
  );
  await writeFile(path.join(codexHome, "skills", "broken-frontmatter", "SKILL.md"), skillDoc("name"));

  await writePlugin({
    codexHome,
    marketplace: "sisyphuslabs",
    pluginDir: "enabled",
    skillDir: "plugin-enabled",
    skillName: `Enabled <script>alert("x")</script>`,
    skillDescription: `Enabled & observable "skill".`
  });
  await writePlugin({
    codexHome,
    marketplace: "marketplace",
    pluginDir: "cached",
    skillDir: "plugin-cached",
    skillName: "Cached Plugin Skill",
    skillDescription: "No config entry means cached."
  });
  await writePlugin({
    codexHome,
    marketplace: "openai-curated-remote",
    pluginDir: "disabled",
    skillDir: "plugin-disabled",
    skillName: "Disabled Plugin Skill",
    skillDescription: "Remote marketplace config uses stripped name."
  });

  const confinedPlugin = path.join(codexHome, "plugins", "cache", "marketplace", "confined", "1.0.0");
  await writeFile(
    path.join(confinedPlugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "confined", skills: "./declared-skills" })
  );
  await writeFile(
    path.join(confinedPlugin, "declared-skills", "inside", "SKILL.md"),
    skillDoc("name: Declared Skill")
  );
  await writeFile(
    path.join(confinedPlugin, "components", "outside", "SKILL.md"),
    skillDoc("name: Leaked Component Skill")
  );

  await writeFile(path.join(codexHome, "plugins", "cache", "bad", "broken", "1.0.0", ".codex-plugin", "plugin.json"), "{");
  await writeFile(
    path.join(codexHome, "config.toml"),
    `[plugins."enabled@sisyphuslabs"]\nenabled = true\n\n[plugins."disabled@openai-curated"]\nenabled = false\n\n[plugins."cached@marketplace"]\nenabled = "true"\n\n[plugins.bad\nenabled = true\n`
  );

  return { codexHome };
}

async function writePlugin({ codexHome, marketplace, pluginDir, skillDir, skillName, skillDescription }) {
  const pluginRoot = path.join(codexHome, "plugins", "cache", marketplace, pluginDir, "1.0.0");
  await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: pluginDir, skills: "./skills" }));
  await writeFile(
    path.join(pluginRoot, "skills", skillDir, "SKILL.md"),
    skillDoc(`name: ${skillName}`, `description: ${skillDescription}`)
  );
  await writeFile(path.join(pluginRoot, "skills", skillDir, "nested", "SKILL.md"), skillDoc("name: Nested Plugin Skill"));
}

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

test("formats escaped, capped Telegram HTML without absolute path leakage", async () => {
  const { codexHome } = await makeFixture();
  const inventory = await collectCodexSkillInventory({ codexHome });

  const html = formatCodexSkillInventory(inventory, { maxChars: 760, maxRows: 3 });

  assert.match(html, /Codex skills/);
  assert.match(html, /observable install\/cache\/config state/);
  assert.match(html, /Warnings: \d+ sanitized/);
  assert.match(html, /more omitted/);
  assert.ok(html.length <= 760);
  assert.ok(!html.includes(codexHome));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /&lt;Skill&gt; &amp; &quot;One&quot;/);
});

test("redacts untrusted skill metadata paths while escaping HTML", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-metadata-");
  await writeFile(
    path.join(codexHome, "skills", ".system", "adversarial", "SKILL.md"),
    skillDoc("name: adversarial", "description: raw /tmp/top-secret and /etc/passwd and /home/openclaw/path <script>")
  );

  const inventory = await collectCodexSkillInventory({ codexHome });
  const html = formatCodexSkillInventory(inventory, { maxChars: 1000 });

  assert.match(html, /raw [\s\S]*\[path\][\s\S]*&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|\/tmp\/top-secret|\/etc\/passwd|\/home\/openclaw\/path/);
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
  const codexHome = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "codex-skills-status-missing-")), "missing-home");

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
  assert.equal(calls.reply[0].extra, undefined);
  assert.match(calls.reply[0].html, /Codex skills/);
  assert.match(calls.reply[0].html, /more omitted/);
  assert.ok(calls.reply[0].html.length <= 760);
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
  assert.equal(calls.edit[0].extra, keyboard);
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

function countStatus(skills, status) {
  return skills.filter((skill) => skill.status === status).length;
}
