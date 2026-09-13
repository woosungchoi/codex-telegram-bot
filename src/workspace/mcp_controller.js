// @ts-check
import { b, code, escapeHtml } from "../telegram/html.js";
import { selectedAccountId } from "../accounts/context.js";
const PAGE = 8;

/** @param {import("./contracts.js").McpServices} services */
export function createMcpController({
  accounts,
  assertAccountIdle,
  assertAdmin,
  backend,
  btn,
  chats,
  currentAccount,
  safe,
  t,
  ui,
}) {
  async function mcpList(
    ctx,
    accountId = currentAccount(ctx),
    health = false,
    page = 0,
  ) {
    assertAdmin(ctx);
    const cwd = chats.options(chats.key(ctx)).workingDirectory;
    const account = await accounts.get(accountId);
    const result = await backend.readMcp(accountId, cwd, health);
    const rows = result.rows.slice(page * PAGE, (page + 1) * PAGE).map((s) => [
      btn(`${s.enabled ? "✅" : "⏸"} ${s.name}`, "mcp-server", {
        accountId,
        cwd,
        server: s,
        version: result.version,
      }),
    ]);
    const navs = [];
    if (page) navs.push(btn("←", "mcp", { accountId, page: page - 1 }));
    if ((page + 1) * PAGE < result.rows.length)
      navs.push(btn("→", "mcp", { accountId, page: page + 1 }));
    if (navs.length) rows.push(navs);
    rows.push([
      btn(t("health"), "mcp", { accountId, health: true }),
      btn(t("reload"), "mcp-reload", { accountId }),
    ]);
    rows.push(
      ...(await accounts.list()).map((a) => [
        btn(a.label, "mcp", { accountId: a.id }),
      ]),
    );
    const details = result.rows
      .slice(page * PAGE, (page + 1) * PAGE)
      .map(
        (s) =>
          `${escapeHtml(s.name)} · ${t(s.status)}${s.tools != null ? ` · ${s.tools} tools` : ""}`,
      )
      .join("\n");
    return ui.show(
      ctx,
      `${b(t("mcp"))}\n${t("account")}: ${b(account.label)}\n${code(cwd)}\n\n${details || t("empty")}\n\n${t("mcpHint")}`,
      rows,
    );
  }

  async function action(ctx, a) {
    if (a.type === "mcp") return mcpList(ctx, a.accountId, a.health, a.page);
    if (a.type === "mcp-reload") {
      assertAdmin(ctx);
      const id = a.accountId || currentAccount(ctx);
      assertAccountIdle(id);
      for (const key of chats.cache.keys())
        if (selectedAccountId(chats.get(key)) === id) chats.cache.delete(key);
      return mcpList(ctx, id, true);
    }
    if (a.type === "mcp-server") {
      assertAdmin(ctx);
      return ui.show(
        ctx,
        `${b(a.server.name)}\n${t(a.server.status)}\n${code(safe(a.server.error || ""))}\n${t("mcpConfirm")}\n\n${t("mcpHint")}`,
        [
          ...(a.server.plugin
            ? []
            : [
                [
                  btn(t(a.server.enabled ? "disable" : "enable"), "mcp-set", {
                    ...a,
                    type: "mcp-set",
                    enabled: !a.server.enabled,
                  }),
                ],
              ]),
          [ui.back("mcp", { accountId: a.accountId })],
        ],
      );
    }
    if (a.type === "mcp-set") {
      assertAdmin(ctx);
      assertAccountIdle(a.accountId);
      await ui.clear(ctx);
      const release = await accounts.acquire(a.accountId);
      try {
        await backend.setMcpEnabled(
          a.accountId,
          a.cwd,
          a.server.name,
          a.enabled,
          a.version,
        );
      } finally {
        await release();
      }
      for (const key of chats.cache.keys())
        if (selectedAccountId(chats.get(key)) === a.accountId)
          chats.cache.delete(key);
      return mcpList(ctx, a.accountId);
    }
    throw new Error(t("expired"));
  }
  return { action };
}
