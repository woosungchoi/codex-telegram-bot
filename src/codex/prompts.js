import { SUPPORTED_LANGUAGES, textFor } from "../i18n.js";

export const DEFAULT_PERSONA_PROMPTS = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((language) => [language, textFor(language, "prompt.persona")])
);

export const DEFAULT_RICH_MARKDOWN_PROMPTS = Object.fromEntries(
  SUPPORTED_LANGUAGES.map((language) => [language, textFor(language, "prompt.richMarkdown")])
);

export const IMAGE_TOOL_OUTPUT_SAFETY_PROMPT = [
  "Image tool-output safety instructions:",
  "- When inspecting local images through programmatic tools, never return multiple images in one tool result.",
  "- Never include raw image bytes, data URLs, or base64 in programmatic tool results. Save each image to a local file and return only its path, pixel dimensions, byte size, and SHA-256 hash.",
  "- If visual inspection is essential, include at most one small low-resolution thumbnail (maximum 512 px on the longest edge and 256 KB), never the original image bytes.",
  "- Inspect at most 10 images in one conversation thread. Then stop with a concise checkpoint and tell the user to continue in a fresh /new thread using the saved paths; do not replay prior image data."
].join("\n");

export function defaultPersonaPrompt(language = "en") {
  return DEFAULT_PERSONA_PROMPTS[language] || DEFAULT_PERSONA_PROMPTS.en;
}

export function defaultRichMarkdownPrompt(language = "en") {
  return DEFAULT_RICH_MARKDOWN_PROMPTS[language] || DEFAULT_RICH_MARKDOWN_PROMPTS.en;
}

export function buildStyleInstructionPrompt({ language = "en", personaPrompt = "" } = {}) {
  return [
    personaPrompt || defaultPersonaPrompt(language),
    defaultRichMarkdownPrompt(language),
    IMAGE_TOOL_OUTPUT_SAFETY_PROMPT
  ].filter(Boolean).join("\n\n");
}
