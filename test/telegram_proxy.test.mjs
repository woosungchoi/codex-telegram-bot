import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import { createTelegramApiAgent } from "../src/telegram/api.js";
import { createTelegramRuntimeContext } from "../src/telegram/runtime_context.js";
import { key, cert } from "./fixtures/proxy_tls.mjs";

function proxyEnvironment(t, values = {}) {
  const keys = [
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "npm_config_http_proxy", "npm_config_https_proxy", "npm_config_proxy", "npm_config_no_proxy",
    "NPM_CONFIG_HTTP_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_PROXY", "NPM_CONFIG_NO_PROXY",
    "NODE_USE_ENV_PROXY"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(t, { secureProxy = false } = {}) {
  const sockets = new Set();
  const proxyRequests = [];
  const apiRequests = [];
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const api = https.createServer({ key, cert }, (req, res) => {
    if (req.url.startsWith("/file/")) {
      res.end("download fixture");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      apiRequests.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "fixture_bot" } }));
    });
  });
  const handleProxyRequest = (req, res) => {
    proxyRequests.push({ method: req.method, url: req.url, auth: req.headers["proxy-authorization"] });
    res.end("proxied attachment");
  };
  const proxy = secureProxy
    ? https.createServer({ key, cert }, handleProxyRequest)
    : http.createServer(handleProxyRequest);
  proxy.on("connect", (req, socket, head) => {
    proxyRequests.push({ method: "CONNECT", url: req.url, auth: req.headers["proxy-authorization"] });
    const upstream = track(net.connect(api.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    }));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  api.on("connection", track);
  proxy.on("connection", track);
  const agent = createTelegramApiAgent();
  // Trust only this fixture certificate, without disabling TLS verification.
  agent.options.ca = cert;
  if (agent.connectOpts) agent.connectOpts.ca = cert;
  if (agent.httpsAgent) agent.httpsAgent.options.ca = cert;
  t.after(async () => {
    agent.destroy();
    agent.httpAgent?.destroy();
    agent.httpsAgent?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([api, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  // Keep failures bounded even if a regression stops a request from completing.
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, 5000);
  t.after(() => clearTimeout(deadline));
  api.listen(0, "127.0.0.1");
  proxy.listen(0, "127.0.0.1");
  await Promise.all([once(api, "listening"), once(proxy, "listening")]);
  const apiRoot = `https://127.0.0.1:${api.address().port}`;
  const proxyUrl = `${secureProxy ? "https" : "http"}://127.0.0.1:${proxy.address().port}`;
  const bot = new Telegraf("123:fixture", {
    telegram: { apiRoot, agent, attachmentAgent: agent }
  });
  return { agent, bot, apiRoot, proxyUrl, proxyRequests, apiRequests };
}

test("Telegram API honors HTTPS_PROXY and lowercase precedence with proxy authentication", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  process.env.HTTPS_PROXY = f.proxyUrl;
  assert.equal((await f.bot.telegram.getMe()).username, "fixture_bot");
  assert.equal(f.proxyRequests[0].method, "CONNECT");

  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  process.env.https_proxy = f.proxyUrl.replace("http://", "http://user:fixture-password@");
  await f.bot.telegram.sendMessage(1, "hello");
  assert.equal(f.proxyRequests.at(-1).auth, `Basic ${Buffer.from("user:fixture-password").toString("base64")}`);
  assert.equal(f.apiRequests.length, 2);
});

test("NO_PROXY supports exact hosts, ports, wildcard, and lowercase precedence", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  const port = new URL(f.apiRoot).port;
  for (const bypass of ["127.0.0.1", `127.0.0.1:${port}`, "*"]) {
    process.env.NO_PROXY = bypass;
    await f.bot.telegram.getMe();
  }
  process.env.NO_PROXY = "unmatched.invalid";
  process.env.no_proxy = "127.0.0.1";
  await f.bot.telegram.getMe();
  assert.equal(f.proxyRequests.length, 0);
  assert.equal(f.apiRequests.length, 4);
});

test("Telegram API stays direct without proxy variables", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  await f.bot.telegram.getMe();
  assert.equal(f.proxyRequests.length, 0);
  assert.equal(f.apiRequests.length, 1);
});

test("HTTP_PROXY and http_proxy route remote attachment requests", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  process.env.HTTP_PROXY = f.proxyUrl;
  const first = await fetch("http://attachment.invalid/file.txt", { agent: f.agent });
  assert.equal(await first.text(), "proxied attachment");

  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  process.env.http_proxy = f.proxyUrl;
  const response = await fetch("http://attachment.invalid/lowercase.txt", { agent: f.agent });
  assert.equal(await response.text(), "proxied attachment");
  assert.equal(f.proxyRequests.length, 2);
});

test("remote attachments and multipart Telegram uploads use the shared agent", {
  // Telegraf 4.16.3 / sandwich-stream also stalls without any proxy on Node 26.
  // Keep HTTP routing coverage above active on every supported Node version.
  skip: Number(process.versions.node.split(".")[0]) === 26
    ? "Pre-existing Telegraf multipart stream compatibility issue on Node 26; use Node 24 LTS for uploads"
    : false
}, async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  process.env.HTTP_PROXY = f.proxyUrl;
  process.env.HTTPS_PROXY = f.proxyUrl;
  await f.bot.telegram.sendDocument(1, { url: "http://attachment.invalid/file.txt" });
  assert.ok(f.proxyRequests.some((req) => req.url === "http://attachment.invalid/file.txt"));
  assert.ok(f.proxyRequests.some((req) => req.method === "CONNECT"));
  assert.match(f.apiRequests[0].body, /proxied attachment/);
});

test("Telegram file downloads share the proxy agent and honor NO_PROXY", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t);
  process.env.HTTPS_PROXY = f.proxyUrl;
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-proxy-upload-"));
  t.after(() => fs.rm(uploadDir, { recursive: true, force: true }));
  const runtime = createTelegramRuntimeContext({
    bot: f.bot,
    agent: f.agent,
    settings: { uploadDir, uploadMaxBytes: 1024 },
    chats: {},
    persistence: {},
    localization: {},
    formatting: { bytes: String }
  });
  const ctx = { telegram: { getFileLink: async () => new URL(`${f.apiRoot}/file/test.pdf`) } };
  const file = await runtime.downloadTelegramFile(ctx, "proxied", ".pdf");
  assert.equal(await fs.readFile(file, "utf8"), "download fixture");
  assert.equal(f.proxyRequests.length, 1);
  process.env.NO_PROXY = "127.0.0.1";
  await runtime.downloadTelegramFile(ctx, "direct", ".pdf");
  assert.equal(f.proxyRequests.length, 1);
});

test("proxy connection failure is reported without falling back to direct access", async (t) => {
  proxyEnvironment(t, { HTTPS_PROXY: "http://127.0.0.1:1" });
  const f = await fixture(t);
  await assert.rejects(f.bot.telegram.getMe(), /ECONNREFUSED/);
  assert.equal(f.apiRequests.length, 0);
});

test("HTTPS proxy servers preserve TLS certificate validation", async (t) => {
  proxyEnvironment(t);
  const f = await fixture(t, { secureProxy: true });
  process.env.HTTPS_PROXY = f.proxyUrl;
  await f.bot.telegram.getMe();
  assert.equal(f.proxyRequests[0].method, "CONNECT");
});

test("proxy selection honors domain suffixes, default ports, and ALL_PROXY fallback", (t) => {
  proxyEnvironment(t, { ALL_PROXY: "http://proxy.invalid:3128" });
  const agent = createTelegramApiAgent();
  t.after(() => agent.destroy());
  assert.equal(agent.getProxyForUrl("https://api.telegram.org"), "http://proxy.invalid:3128");
  for (const entry of [".telegram.org", "*.telegram.org", "api.telegram.org:443"]) {
    process.env.NO_PROXY = entry;
    assert.equal(agent.getProxyForUrl("https://api.telegram.org"), "", entry);
  }
  for (const entry of ["telegram.org", "api.telegram.org:444"]) {
    process.env.NO_PROXY = entry;
    assert.equal(agent.getProxyForUrl("https://api.telegram.org"), "http://proxy.invalid:3128", entry);
  }
  process.env.NO_PROXY = "localhost,127.0.0.1,[::1]";
  assert.equal(agent.getProxyForUrl("https://[::1]/file"), "");
});
