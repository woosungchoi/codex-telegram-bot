import { registerTelegramMiddleware } from "../src/telegram/message_router.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  UI_TEXT,
  SUPPORTED_LANGUAGES,
  createMessageFormatter,
  errorText,
  LocalizedError,
  restoreLocalizedError,
  textFor,
} from "../src/i18n.js";
import { code } from "../src/telegram/html.js";
import { createRuntimePanelViews } from "../src/ui/panels.js";
import { createRuntimeKeyboardViews } from "../src/ui/keyboards.js";
import {
  formatCodexSkillInventory,
  codexSkillsKeyboard,
} from "../src/codex/skills_format.js";
import { formatCodexUsageSummary } from "../src/status_usage.js";
import { formatDurationSeconds } from "../src/utils/time.js";
import { errorResponse } from "../src/worker/protocol.js";
import { buildStyleInstructionPrompt } from "../src/codex/prompts.js";
import { uiLocalizationProblems } from "../scripts/check-ui-localization.mjs";
import { runtimeRoutesFixture } from "./helpers/runtime_routes_fixture.mjs";
import { workspaceFixture } from "./helpers/workspace_fixture.mjs";

const locales = SUPPORTED_LANGUAGES;
const makeText = (language) => (key) => {
  assert.equal(
    typeof UI_TEXT[language][key],
    "string",
    `${language}:${key} must not fall back to English`,
  );
  return UI_TEXT[language][key];
};

test("fixed UI strings and unknown keys fail the source guard, while protocol values remain exact", () => {
  const source =
    'b("Current model"); ctx.reply(`Please choose ${value}`); const button = { text: "Refresh", callback_data: "refresh" }; msg("ui.missing"); new LocalizedError("errors.missing");';
  assert.equal(uiLocalizationProblems(source, UI_TEXT.en).length, 5);
  assert.deepEqual(
    uiLocalizationProblems(
      'b(t("title")); ctx.reply(value); code("/model default"); console.log("Worker started"); const button = { text: "03:00", callback_data: "set:time:3" };',
      UI_TEXT.en,
    ),
    [],
  );
});

test("formatting preserves escaped input and does not reinterpret user placeholders", () => {
  const msg = createMessageFormatter(makeText("ru"));
  const value = code("<b>name</b> & {value2}");
  assert.equal(
    msg("ui.modelLine", { value1: value, value2: "MUST NOT REPLACE" }),
    `Модель: ${value}`,
  );
  assert.doesNotMatch(
    msg("ui.modelLine", { value1: value }),
    /<b>name|MUST NOT/,
  );
});

test("localized errors survive worker frames while diagnostic messages and foreign errors remain intact", () => {
  const original = new LocalizedError("errors.telegramDownload", {
    status: 404,
  });
  const frame = JSON.parse(JSON.stringify(errorResponse("request", original)));
  const restored = restoreLocalizedError(frame.error, "errors.workerFailed");
  assert.equal(restored.message, "Telegram file download failed: 404");
  for (const language of locales) {
    assert.equal(
      errorText(restored, language),
      createMessageFormatter(makeText(language))("errors.telegramDownload", {
        status: 404,
      }),
    );
  }
  const foreign = new Error("Provider response: <quota> {status}");
  assert.equal(errorText(foreign, "ru"), foreign.message);
  const future = restoreLocalizedError(
    { message: "future peer error", localeKey: "errors.future" },
    "errors.workerFailed",
  );
  assert.equal(errorText(future, "ru"), "future peer error");
});

test("all supported languages render panels, skills, warnings, usage and durations without fallback", () => {
  for (const language of ["en", "ko", "zh-tw", "ru"])
    assert.ok(locales.includes(language));
  for (const language of locales) {
    const text = makeText(language),
      msg = createMessageFormatter(text);
    const views = createRuntimePanelViews({ text, formatText: msg });
    const main = views.renderMainPanelHtml({
      details: {
        active: false,
        queued: 2,
        queueMode: "safe",
        queuePaused: false,
      },
      options: {
        model: "gpt-test",
        modelReasoningEffort: "high",
        workingDirectory: "/work/<name>",
      },
      transport: "sdk",
    });
    assert.ok(main.includes(text("ui.codexControl")));
    assert.ok(main.includes(text("ui.notStarted")));
    assert.ok(main.includes("/work/&lt;name&gt;"));
    const zone = views.renderTimeZoneGroupPanelHtml("asia", "Asia/Seoul");
    assert.ok(zone.includes(text("timeZoneGroup.asia")));
    const inventory = {
      skills: [{ displayName: "skill <name>", status: "local/custom" }],
      warnings: [
        {
          messageKey: "skills.warning.skillFileUnavailable",
          message: "skill file unavailable",
          target: "CODEX_HOME/skills/test",
        },
      ],
    };
    assert.ok(
      formatCodexSkillInventory(inventory, { text }).includes(
        text("skills.title"),
      ),
    );
    const warnings = formatCodexSkillInventory(inventory, { text, view: "w" });
    assert.ok(warnings.includes(text("skills.warning.skillFileUnavailable")));
    assert.equal(
      codexSkillsKeyboard(inventory, { text }).reply_markup
        .inline_keyboard[0][0].text,
      text("skills.all"),
    );
    const usage = formatCodexUsageSummary({
      text,
      tokenCount: {
        info: {
          last_token_usage: { input_tokens: 100 },
          model_context_window: 1000,
        },
        rate_limits: { primary: { used_percent: 25, resets_at: 1789516800 } },
      },
      sampledAt: "2026-09-15T12:00:00Z",
      now: new Date("2026-09-15T12:01:00Z"),
    });
    assert.ok(usage.includes(text("usage.title")));
    assert.ok(usage.includes("90%"));
    assert.ok(usage.includes(formatDurationSeconds(60, text)));
    assert.doesNotMatch(
      main + zone + warnings + usage,
      /\{(?:value\d|count|time|age|percent)\}/,
    );
    if (language !== "en") {
      assert.doesNotMatch(
        main + zone + warnings + usage,
        /Current:|not started|skill file unavailable|Codex usage/,
      );
    }
  }
});

test("translated keyboard labels preserve every callback and destructive button style", () => {
  let baseline;
  for (const language of locales) {
    const text = makeText(language);
    const views = createRuntimeKeyboardViews({
      text,
      hasActiveTurn: () => true,
      sideTurnCount: () => 0,
      currentLanguage: () => "en",
      currentTimeZone: () => "UTC",
      currentLocale: () => "en-US",
    });
    const names = [
      "mainPanelKeyboard",
      "sandboxKeyboard",
      "approvalKeyboard",
      "webSearchKeyboard",
      "runtimeOutputKeyboard",
      "runtimeQueueKeyboard",
      "runtimeCodexKeyboard",
      "runtimeCleanupKeyboard",
      "runtimeSnapshotKeyboard",
      "timeZoneKeyboard",
    ];
    const keyboards = names.map((name) =>
      views[name]("chat").reply_markup.inline_keyboard.map((row) =>
        row.map(({ text: _text, ...button }) => button),
      ),
    );
    if (baseline) assert.deepEqual(keyboards, baseline, language);
    else baseline = keyboards;
    const sandbox = views
      .sandboxKeyboard()
      .reply_markup.inline_keyboard.flat()
      .find((button) => button.callback_data === "set:sandbox:ro");
    assert.ok(sandbox.text.includes(text("ui.readOnly")));
  }
});

for (const language of locales) {
  test(`${language}: Telegram navigation translates panels and keeps the same message`, async (t) => {
    const f = await runtimeRoutesFixture(t, {
      state: { ui: { language, timeZone: "UTC" }, chats: {} },
    });
    await f.send("/menu");
    const message = f.messages.at(-1),
      id = message.message_id;
    assert.ok(message.html.includes(textFor(language, "ui.codexControl")));
    for (const [panel, title] of [
      ["settings", "ui.codexSettings"],
      ["settings_runtime_output", "ui.outputRuntime"],
      ["tools", "ui.codexTools"],
      ["main", "ui.codexControl"],
    ]) {
      await f.click(`p:${panel}`);
      assert.equal(f.messages.length, 1);
      assert.equal(f.messages.at(-1).message_id, id);
      assert.ok(
        f.messages.at(-1).html.includes(textFor(language, title)),
        `${language}:${panel}`,
      );
    }
    // Factories must read the language at render time, even after initialization.
    f.state.ui.language = language === "ru" ? "ko" : "ru";
    await f.click("p:main");
    assert.ok(
      message.html.includes(textFor(f.state.ui.language, "ui.codexControl")),
    );
  });
  test(`${language}: invalid folder input is translated at the presentation boundary`, async (t) => {
    const f = await workspaceFixture(t, {
      state: { ui: { language, timeZone: "UTC" }, chats: {} },
    });
    await f.send("/projects");
    await f.press(textFor(language, "workspace.path"));
    await f.send("relative/path");
    assert.ok(
      f.messages
        .at(-1)
        .text.includes(textFor(language, "errors.enterAnAbsoluteFolderPath")),
    );
    assert.equal(f.forwarded.length, 0);
  });
}

test("Russian selection requests Russian answers and keeps the same formatting and safety guidance", () => {
  const prompt = buildStyleInstructionPrompt({ language: "ru" });
  assert.match(prompt, /Всегда отвечайте по-русски/);
  assert.match(prompt, /HTTP\(S\)/);
  assert.match(prompt, /Image tool-output safety instructions/);
  assert.doesNotMatch(prompt, /Always answer in.*English/);
});

test("uncaught application validation errors use the selected language without translating provider diagnostics", async (t) => {
  t.mock.method(console, "error", () => {});
  let handler;
  const replies = [];
  registerTelegramMiddleware({
    bot: {
      catch: (callback) => {
        handler = callback;
      },
      use: () => {},
    },
    config: { telegramLanguage: "ru" },
    authorize: () => ({ ok: true }),
    telegram: {
      text: makeText("ru"),
      summarizeError: (error) => ({ description: error.message }),
      replyHtml: async (_ctx, html) => {
        replies.push(html);
      },
    },
  });
  await handler(
    new LocalizedError("errors.telegramDownload", { status: 403 }),
    { chat: { id: 1 } },
  );
  assert.ok(replies[0].includes("Не удалось скачать файл Telegram: 403"));
  await handler(new Error("Provider rejected <input>"), { chat: { id: 1 } });
  assert.ok(replies[1].includes("Provider rejected &lt;input&gt;"));
});
