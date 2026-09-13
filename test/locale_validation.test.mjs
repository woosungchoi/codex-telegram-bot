import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UI_TEXT } from "../src/i18n.js";
import { accountText } from "../src/accounts/messages.js";
import { workspaceText } from "../src/workspace/messages.js";
import { forumText } from "../src/forum/messages.js";
import { validateLocaleMessages } from "../src/i18n/validation.js";

test("locale validation catches missing domain messages, wrong types and placeholder drift", () => {
  const base = { "accounts.title": "Accounts", line: "{count} items in {folder}", suffix: "" };
  validateLocaleMessages(base, { ...base, line: "{folder}: {count}" });
  assert.throws(() => validateLocaleMessages(base, { line: base.line, suffix: "" }), /missing keys.*accounts.title/);
  assert.throws(() => validateLocaleMessages(base, { ...base, line: "{counts} items" }), /placeholders/);
  assert.throws(() => validateLocaleMessages(base, { ...base, line: 1 }), /string/);
  assert.throws(() => validateLocaleMessages(base, { ...base, line: " " }), /empty/);
});

test("all domain facades use locale messages with their original unknown-key behavior", () => {
  for (const [language, messages] of Object.entries(UI_TEXT)) {
    validateLocaleMessages(UI_TEXT.en, messages, language);
    for (const [domain, translate] of [["accounts", accountText], ["workspace", workspaceText], ["forum", forumText]]) {
      for (const key of Object.keys(messages).filter((key) => key.startsWith(`${domain}.`))) {
        assert.equal(translate(language, key.slice(domain.length + 1)), messages[key]);
      }
    }
  }
  assert.equal(accountText("missing", "title"), UI_TEXT.en["accounts.title"]);
  assert.equal(workspaceText("missing", "projects"), UI_TEXT.en["workspace.projects"]);
  assert.equal(accountText("en", "unknown-key"), "unknown-key");
  assert.equal(forumText("en", "unknown-key"), undefined);
});

test("adding a locale alone makes the same language available to every domain", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-locales-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.mkdir(path.join(root, "locales"));
  await fs.copyFile(new URL("../src/i18n.js", import.meta.url), path.join(root, "i18n.js"));
  for (const language of ["en", "ja"]) {
    const messages = { ...UI_TEXT.en, _meta: { code: language, nativeName: language, englishName: language } };
    for (const domain of ["accounts", "workspace", "forum"]) {
      messages[`${domain}.integrationProbe`] = `${language}:${domain}`;
    }
    await fs.writeFile(path.join(root, "locales", `${language}.json`), JSON.stringify(messages));
  }
  for (const [domain, fn] of [["accounts", "accountText"], ["workspace", "workspaceText"], ["forum", "forumText"]]) {
    await fs.mkdir(path.join(root, domain));
    const file = path.join(root, domain, "messages.js");
    await fs.copyFile(new URL(`../src/${domain}/messages.js`, import.meta.url), file);
    const module = await import(pathToFileURL(file).href);
    assert.equal(module[fn]("ja", "integrationProbe"), `ja:${domain}`);
  }
});
