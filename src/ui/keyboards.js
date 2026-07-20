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

export function modelSelectionKeyboard(models, { callbackPrefix = "model:set:" } = {}) {
  const buttons = models.map((model) => ({
    text: `${model.displayName}${model.fastSupported ? " ⚡" : ""}`,
    callback_data: `${callbackPrefix}${model.slug}`
  }));
  return {
    reply_markup: {
      inline_keyboard: [
        ...chunk(buttons, 2),
        [{ text: "Default", callback_data: `${callbackPrefix}default` }]
      ]
    }
  };
}

export function reasoningSelectionKeyboard(reasoningOptions, { callbackPrefix = "reasoning:set:" } = {}) {
  const buttons = [
    { text: "Default", callback_data: `${callbackPrefix}default` },
    ...reasoningOptions.map(({ effort }) => ({
      text: effort,
      callback_data: `${callbackPrefix}${effort}`
    }))
  ];
  return {
    reply_markup: {
      inline_keyboard: chunk(buttons, 3)
    }
  };
}
