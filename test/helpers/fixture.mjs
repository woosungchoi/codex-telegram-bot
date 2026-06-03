export function botCommandMessage(text, length = text.split(/\s+/, 1)[0].length) {
  return { text, entities: [{ type: "bot_command", offset: 0, length }] };
}
