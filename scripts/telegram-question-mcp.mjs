#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createWorkerClient } from "../src/worker/client.js";

const client = createWorkerClient({ codexWorkerSocket: process.env.TELEGRAM_QUESTION_SOCKET });
const spec = {
  name: "ask_decisions",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  description: "Ask the requesting Telegram user required decisions. Displays one question at a time and blocks until ALL answers are received. Use before dependent actions; never run it in parallel with dependent work. No default answers or timeouts count as consent. Do not request secrets.",
  inputSchema: { type: "object", properties: { questions: { type: "array", minItems: 1, maxItems: 20,
    items: { type: "object", properties: {
      id: { type: "string" }, question: { type: "string" },
      options: { type: "array", maxItems: 20, items: { type: "object", properties: {
        label: { type: "string" }, description: { type: "string" }
      }, required: ["label", "description"], additionalProperties: false } }
    }, required: ["id", "question", "options"], additionalProperties: false }
  } }, required: ["questions"], additionalProperties: false }
};
function send(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id == null) return;
    if (request.method === "initialize") return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "telegram-questions", version: "1.0.0" } });
    if (request.method === "ping") return send(request.id, {});
    if (request.method === "tools/list") return send(request.id, { tools: [spec] });
    if (request.method !== "tools/call" || request.params?.name !== spec.name) throw new Error("Unsupported MCP request");
    const result = await client.askQuestions(process.env.TELEGRAM_QUESTION_JOB, request.params.arguments?.questions);
    send(request.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (error) {
    if (request?.id != null) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } })}\n`);
  }
});
