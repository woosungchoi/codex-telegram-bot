export function booleanOptionKeyboardRows(key, settingsLabel) {
  return [
    [
      { text: "default", callback_data: `set:${key}:default` },
      { text: "on", callback_data: `set:${key}:on` },
      { text: "off", callback_data: `set:${key}:off` }
    ],
    [{ text: settingsLabel, callback_data: "p:settings" }]
  ];
}

function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

export function modelSelectionKeyboard(models) {
  const buttons = models.map((model) => ({
    text: `${model.displayName}${model.fastSupported ? " ⚡" : ""}`,
    callback_data: `model:set:${model.slug}`
  }));
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(buttons, 2),
        [{ text: "Default", callback_data: "model:set:default" }]
      ]
    }
  };
}

export function reasoningSelectionKeyboard(reasoningOptions) {
  const buttons = [
    { text: "Default", callback_data: "reasoning:set:default" },
    ...reasoningOptions.map(({ effort }) => ({
      text: effort,
      callback_data: `reasoning:set:${effort}`
    }))
  ];
  return {
    reply_markup: {
      inline_keyboard: chunk(buttons, 3)
    }
  };
}
