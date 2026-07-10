import test from "node:test";
import assert from "node:assert/strict";
import {
  booleanOptionKeyboardRows,
  modelSelectionKeyboard,
  reasoningSelectionKeyboard
} from "../src/ui/keyboards.js";

test("boolean option keyboard rows include default, on, off, and settings back row", () => {
  assert.deepEqual(booleanOptionKeyboardRows("network", "Settings"), [
    [
      { text: "default", callback_data: "set:network:default" },
      { text: "on", callback_data: "set:network:on" },
      { text: "off", callback_data: "set:network:off" }
    ],
    [{ text: "Settings", callback_data: "p:settings" }]
  ]);
});

const solTerraReasoning = [
  { effort: "low", description: "Fast answers" },
  { effort: "medium", description: "Balanced answers" },
  { effort: "high", description: "More reasoning" },
  { effort: "xhigh", description: "Extended reasoning" },
  { effort: "max", description: "Maximum reasoning" },
  { effort: "ultra", description: "Automatic delegation" }
];

const lunaReasoning = solTerraReasoning.slice(0, 5);

test("model-aware model keyboard keeps two columns, fast markers, and final Default", () => {
  assert.deepEqual(
    modelSelectionKeyboard([
      { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", fastSupported: true },
      { slug: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", fastSupported: false },
      { slug: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", fastSupported: true }
    ]),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "GPT-5.6 Sol ⚡", callback_data: "model:set:gpt-5.6-sol" },
            { text: "GPT-5.6 Terra", callback_data: "model:set:gpt-5.6-terra" }
          ],
          [{ text: "GPT-5.6 Luna ⚡", callback_data: "model:set:gpt-5.6-luna" }],
          [{ text: "Default", callback_data: "model:set:default" }]
        ]
      }
    }
  );
});

test("Sol and Terra reasoning keyboard includes max and ultra in advertised order", () => {
  assert.deepEqual(reasoningSelectionKeyboard(solTerraReasoning), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Default", callback_data: "reasoning:set:default" },
          { text: "low", callback_data: "reasoning:set:low" },
          { text: "medium", callback_data: "reasoning:set:medium" }
        ],
        [
          { text: "high", callback_data: "reasoning:set:high" },
          { text: "xhigh", callback_data: "reasoning:set:xhigh" },
          { text: "max", callback_data: "reasoning:set:max" }
        ],
        [{ text: "ultra", callback_data: "reasoning:set:ultra" }]
      ]
    }
  });
});

test("Luna reasoning keyboard includes max and excludes ultra", () => {
  assert.deepEqual(reasoningSelectionKeyboard(lunaReasoning), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Default", callback_data: "reasoning:set:default" },
          { text: "low", callback_data: "reasoning:set:low" },
          { text: "medium", callback_data: "reasoning:set:medium" }
        ],
        [
          { text: "high", callback_data: "reasoning:set:high" },
          { text: "xhigh", callback_data: "reasoning:set:xhigh" },
          { text: "max", callback_data: "reasoning:set:max" }
        ]
      ]
    }
  });
});

test("legacy and unknown reasoning options are rendered without model inference", () => {
  const options = ["minimal", "low", "medium", "high", "xhigh"].map((effort) => ({
    effort,
    description: `Description for ${effort}`
  }));

  assert.deepEqual(reasoningSelectionKeyboard(options), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Default", callback_data: "reasoning:set:default" },
          { text: "minimal", callback_data: "reasoning:set:minimal" },
          { text: "low", callback_data: "reasoning:set:low" }
        ],
        [
          { text: "medium", callback_data: "reasoning:set:medium" },
          { text: "high", callback_data: "reasoning:set:high" },
          { text: "xhigh", callback_data: "reasoning:set:xhigh" }
        ]
      ]
    }
  });
});

test("empty inputs leave stable Default controls", () => {
  assert.deepEqual(modelSelectionKeyboard([]), {
    reply_markup: {
      inline_keyboard: [[{ text: "Default", callback_data: "model:set:default" }]]
    }
  });
  assert.deepEqual(reasoningSelectionKeyboard([]), {
    reply_markup: {
      inline_keyboard: [[{ text: "Default", callback_data: "reasoning:set:default" }]]
    }
  });
});

test("callback lengths stay within Telegram limits and descriptions never enter output", () => {
  const maximumModelSlug = "m".repeat(54);
  const maximumEffort = "e".repeat(50);
  const injectedDescription = "Default </button> reasoning:set:ultra";
  const maximumReasoningKeyboard = reasoningSelectionKeyboard([
    { effort: maximumEffort, description: injectedDescription }
  ]);
  assert.deepEqual(maximumReasoningKeyboard, {
    reply_markup: {
      inline_keyboard: [[
        { text: "Default", callback_data: "reasoning:set:default" },
        { text: maximumEffort, callback_data: `reasoning:set:${maximumEffort}` }
      ]]
    }
  });

  const keyboards = [
    modelSelectionKeyboard([
      { slug: maximumModelSlug, displayName: "Custom", fastSupported: false }
    ]),
    maximumReasoningKeyboard
  ];

  const buttons = keyboards.flatMap(({ reply_markup }) => reply_markup.inline_keyboard.flat());
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, button.callback_data);
  }
  assert.equal(Buffer.byteLength(`model:set:${maximumModelSlug}`, "utf8"), 64);
  assert.equal(Buffer.byteLength(`reasoning:set:${maximumEffort}`, "utf8"), 64);
});
