import fs from "node:fs/promises";
import path from "node:path";
import { connectAppServer } from "../codex/app_server.js";
import { accountConfig } from "./context.js";
import { classifyAccountFailure } from "./errors.js";

export async function signInAccount({ config, store, label, signal, onCode, timeoutMs = 10 * 60_000, connect = connectAppServer }) {
  signal?.throwIfAborted();
  const account = await store.create(label);
  const scoped = accountConfig(config, account.id);
  let client, loginId, timer, unsubscribe, abort;
  let succeeded = false;
  try {
    signal?.throwIfAborted();
    client = await connect(scoped);
    signal?.throwIfAborted();
    let settle;
    const notices = [];
    const completed = new Promise((resolve) => { settle = resolve; });
    unsubscribe = client.onNotification((event) => {
      if (event.method !== "account/login/completed") return;
      notices.push(event.params);
      if (event.params?.loginId === loginId) settle(event.params);
    });
    abort = () => { settle({ success: false, cancelled: true }); client.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => settle({ success: false, expired: true }), timeoutMs);
    client.exited?.then(() => settle({ success: false, disconnected: true }));
    const login = await client.request("account/login/start", { type: "chatgptDeviceCode" });
    loginId = login.loginId;
    if (!loginId || login.type !== "chatgptDeviceCode") throw new Error("Device login is unavailable in this Codex CLI. Update Codex and retry.");
    const url = new URL(login.verificationUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
      || !/^[A-Z0-9-]{4,64}$/i.test(login.userCode || "")) throw new Error("Invalid device login response.");
    signal?.throwIfAborted();
    await onCode({ verificationUrl: url.href, userCode: login.userCode, accountId: account.id });
    const alreadyDone = notices.find((notice) => notice.loginId === loginId);
    if (alreadyDone) settle(alreadyDone);
    const result = await completed;
    signal?.throwIfAborted();
    if (!result.success) throw new Error(result.expired ? "Device login expired. Run /reauth again." : "Device login did not complete. Check ChatGPT device-code login permissions and retry.");
    const authFile = path.join(scoped.codexHome, "auth.json");
    const stat = await fs.stat(authFile);
    if (!stat.isFile() || stat.size === 0) throw new Error("Login completed without a credential cache.");
    await fs.chmod(authFile, 0o600);
    const { account: identity } = await client.request("account/read", { refreshToken: false });
    if (identity?.type !== "chatgpt") throw new Error("ChatGPT sign-in was not verified.");
    const ready = await store.update(account.id, { status: "ready", planType: identity.planType || "unknown", cooldownUntil: 0 });
    succeeded = true;
    return ready;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    if (!succeeded && loginId) await client?.request("account/login/cancel", { loginId }).catch(() => {});
    await client?.close();
    if (!succeeded) await store.remove(account.id);
  }
}

export async function inspectAccount(config, id, { connect = connectAppServer } = {}) {
  const client = await connect(accountConfig(config, id));
  try {
    const response = await client.request("account/read", { refreshToken: true });
    if (!response.account) return { status: "reauth" };
    const limits = await client.request("account/rateLimits/read").catch((error) => {
      if (classifyAccountFailure(error)?.kind === "auth") return { unauthenticated: true };
      return null;
    });
    if (limits?.unauthenticated) return { status: "reauth" };
    if (!limits?.rateLimits) return { status: "ready", planType: response.account.planType || response.account.type, usedPercent: null };
    const rate = limits?.rateLimits;
    const windows = [rate?.primary, rate?.secondary].filter(Boolean);
    const exhausted = windows.filter((window) => window.usedPercent >= 100);
    return {
      status: "ready",
      planType: response.account.planType || response.account.type,
      usedPercent: rate?.primary?.usedPercent ?? null,
      cooldownUntil: exhausted.length ? Math.max(...exhausted.map((window) => Number(window.resetsAt || 0) * 1000)) : 0,
      failureCode: exhausted.length ? "quota" : null
    };
  } finally { await client.close(); }
}
