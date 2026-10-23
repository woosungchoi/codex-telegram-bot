import fs from "node:fs";
import path from "node:path";

export function isolatedUpdateCommand(staged, home, args) {
  const nodeRoot = path.resolve(path.dirname(process.execPath), "..");
  const mounts = ["/usr", "/lib", "/lib64", "/bin", nodeRoot]
    .filter((value, index, all) => fs.existsSync(value) && all.indexOf(value) === index);
  const flags = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ...mounts.flatMap((value) => ["--ro-bind", value, value]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", staged, "/work", "--bind", home, "/home/review", "--chdir", "/work",
    "--clearenv", "--setenv", "PATH", `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    "--setenv", "HOME", "/home/review", "--setenv", "CODEX_HOME", "/home/review/.codex",
    "--setenv", "npm_config_ignore_scripts", "true"];
  return { command: "/usr/bin/bwrap", args: [...flags, process.execPath, ...args] };
}

export async function verifyIsolatedUpdate(staged, home, run, options) {
  const npm = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  for (const script of ["check", "lint", "format:check", "format:source", "typecheck", "check:architecture", "check:ui-localization", "test"]) {
    const invocation = isolatedUpdateCommand(staged, home, [npm, "run", script]);
    await run(invocation.command, invocation.args, options);
  }
  const smoke = isolatedUpdateCommand(staged, home, ["--input-type=module", "-e", 'import { Codex } from "@openai/codex-sdk"; new Codex({codexPathOverride:process.execPath});']);
  await run(smoke.command, smoke.args, options);
}
