export function messagePlaceholders(text) {
  return [
    ...new Set(
      [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

export function validateLocaleMessages(base, messages, name = "locale") {
  const keys = (value) =>
    Object.keys(value)
      .filter((key) => key !== "_meta")
      .sort();
  const expected = keys(base),
    actual = keys(messages);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length)
    throw new Error(
      `${name}: missing keys [${missing.join(", ")}]; unknown keys [${extra.join(", ")}]`,
    );
  for (const key of expected) {
    for (const value of [base[key], messages[key]]) {
      if (typeof value !== "string")
        throw new Error(`${name}: ${key} must be a string.`);
    }
    if (base[key].trim() && !messages[key].trim())
      throw new Error(`${name}: ${key} must not be empty.`);
    if (
      JSON.stringify(messagePlaceholders(base[key])) !==
      JSON.stringify(messagePlaceholders(messages[key]))
    ) {
      throw new Error(`${name}: ${key} has mismatched placeholders.`);
    }
  }
}
