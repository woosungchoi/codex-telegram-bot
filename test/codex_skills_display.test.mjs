import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { codexSkillsKeyboard, collectCodexSkillInventory, formatCodexSkillInventory, replyCodexSkillsStatus } from "../src/codex/skills_status.js";
import { makeFixture, skillDoc, tempCodexHome, writeFile } from "./helpers/codex_skills_status_fixture.mjs";

test("paginates compact skills instead of globally hiding later status groups", () => {
  const inventory = {
    skills: [
      skill("local/system", "system-one"),
      skill("local/custom", "custom-one"),
      ...Array.from({ length: 8 }, (_, index) => skill("plugin enabled", `enabled-${index}`, "omo@sisyphuslabs")),
      skill("plugin cached", "cached-one", "cached@marketplace")
    ],
    warnings: []
  };

  const html = formatCodexSkillInventory(inventory, { maxChars: 1000, maxRows: 3 });

  assert.match(html, /plugin enabled/);
  assert.match(html, /enabled-0/);
  assert.match(html, /Page 1\/\d+/);
  assert.match(html, /more omitted/);
  assert.doesNotMatch(html, /cached-one/);
});

test("collapses duplicate display rows while preserving scanned and source counts", () => {
  const inventory = {
    skills: [
      skill("plugin enabled", "ast-grep", "omo@sisyphuslabs", "First description.", "CODEX_HOME/plugins/cache/a/SKILL.md"),
      skill("plugin enabled", "ast-grep", "omo@sisyphuslabs", "Second description.", "CODEX_HOME/plugins/cache/b/SKILL.md"),
      skill("plugin enabled", "debugging", "omo@sisyphuslabs", "Debug description.")
    ],
    warnings: []
  };

  const html = formatCodexSkillInventory(inventory, { maxChars: 1200 });
  const detail = formatCodexSkillInventory(inventory, { maxChars: 1200, query: "ast-grep" });

  assert.match(html, /unique 2 \/ scanned 3/);
  assert.match(html, /duplicates 1/);
  assert.equal([...html.matchAll(/ast-grep/g)].length, 1);
  assert.match(detail, /Sources: 2/);
  assert.match(detail, /First description/);
});

test("parses block scalar skill descriptions for detail output", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-block-");
  await writeFile(
    path.join(codexHome, "skills", "deep-interview", "SKILL.md"),
    skillDoc("name: deep-interview", "description: |", "  Ask focused questions.", "  Keep answers <safe> & useful.")
  );

  const inventory = await collectCodexSkillInventory({ codexHome });
  const skillInfo = inventory.skills.find((item) => item.displayName === "deep-interview");
  const html = formatCodexSkillInventory(inventory, { maxChars: 1000, query: "deep-interview" });

  assert.equal(skillInfo?.description, "Ask focused questions.\nKeep answers <safe> & useful.");
  assert.match(html, /Ask focused questions/);
  assert.match(html, /Keep answers &lt;safe&gt; &amp; useful/);
  assert.doesNotMatch(html, / - \|/);
});

test("renders sanitized warnings only in the warnings view", async () => {
  const codexHome = await tempCodexHome("codex-skills-status-warnings-");

  const inventory = await collectCodexSkillInventory({ codexHome });
  const defaultHtml = formatCodexSkillInventory(inventory, { maxChars: 1000 });
  const warningHtml = formatCodexSkillInventory(inventory, { maxChars: 1000, view: "w" });

  assert.match(defaultHtml, /Warnings: \d+ sanitized/);
  assert.doesNotMatch(defaultHtml, /Codex config unavailable/);
  assert.match(warningHtml, /Codex skill warnings/);
  assert.match(warningHtml, /Codex config unavailable/);
  assert.match(warningHtml, /CODEX_HOME/);
  assert.doesNotMatch(warningHtml, new RegExp(codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("replies with queried skill detail when a /skills query is supplied", async () => {
  const { codexHome } = await makeFixture();
  const calls = [];
  const deps = {
    config: { codexHome },
    runtimeValue: (key) => (key === "maxTelegramChars" ? 1000 : undefined),
    async replyHtml(_ctx, html, extra) {
      calls.push({ html, extra });
      return { message_id: 41 };
    },
    async editOrReplyHtml() {
      throw new Error("edit should not be used");
    }
  };

  const result = await replyCodexSkillsStatus({ chat: { id: 1 } }, deps, { query: "Enabled" });

  assert.deepEqual(result, { message_id: 41 });
  assert.match(calls[0].html, /Codex skill detail/);
  assert.match(calls[0].html, /Enabled &lt;script&gt;alert/);
  assert.match(calls[0].html, /Enabled &amp; observable &quot;skill&quot;/);
  assert.ok(collectCallbackData(calls[0].extra).includes("sk:a:0"));
});

test("builds bounded skills navigation callback data", async () => {
  const { codexHome } = await makeFixture();
  const inventory = await collectCodexSkillInventory({ codexHome });

  const extra = codexSkillsKeyboard(inventory, { view: "e", page: 0 });
  const callbacks = collectCallbackData(extra);

  assert.ok(callbacks.includes("sk:a:0"));
  assert.ok(callbacks.includes("sk:e:0"));
  assert.ok(callbacks.includes("sk:w:0"));
  assert.ok(callbacks.every((value) => Buffer.byteLength(value) <= 64));
  assert.ok(callbacks.every((value) => !value.includes("Enabled")));
});

function skill(status, displayName, pluginKey = "", description = "", relativePath = `CODEX_HOME/${displayName}/SKILL.md`) {
  return { status, displayName, pluginKey, description, relativePath };
}

function collectCallbackData(extra) {
  return (extra?.reply_markup?.inline_keyboard || []).flat().map((button) => button.callback_data).filter(Boolean);
}
