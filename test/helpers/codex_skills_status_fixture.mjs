import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

export function skillDoc(...frontmatter) {
  return ["---", ...frontmatter, "---", "Body"].join("\n");
}

export async function tempCodexHome(prefix) {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), prefix)), "codex-home");
}

export async function makeFixture() {
  const codexHome = await tempCodexHome("codex-skills-status-");

  await writeFile(
    path.join(codexHome, "skills", ".system", "system-one", "SKILL.md"),
    skillDoc(`name: System <Skill> & "One"`, `description: Use <b>bold</b> & "quotes".`)
  );
  await writeFile(
    path.join(codexHome, "skills", "custom-one", "SKILL.md"),
    skillDoc("description: Custom skill without name.")
  );
  await writeFile(path.join(codexHome, "skills", "broken-frontmatter", "SKILL.md"), skillDoc("name"));

  await writePlugin({
    codexHome,
    marketplace: "sisyphuslabs",
    pluginDir: "enabled",
    skillDir: "plugin-enabled",
    skillName: `Enabled <script>alert("x")</script>`,
    skillDescription: `Enabled & observable "skill".`
  });
  await writePlugin({
    codexHome,
    marketplace: "marketplace",
    pluginDir: "cached",
    skillDir: "plugin-cached",
    skillName: "Cached Plugin Skill",
    skillDescription: "No config entry means cached."
  });
  await writePlugin({
    codexHome,
    marketplace: "openai-curated-remote",
    pluginDir: "disabled",
    skillDir: "plugin-disabled",
    skillName: "Disabled Plugin Skill",
    skillDescription: "Remote marketplace config uses stripped name."
  });

  const confinedPlugin = path.join(codexHome, "plugins", "cache", "marketplace", "confined", "1.0.0");
  await writeFile(
    path.join(confinedPlugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "confined", skills: "./declared-skills" })
  );
  await writeFile(
    path.join(confinedPlugin, "declared-skills", "inside", "SKILL.md"),
    skillDoc("name: Declared Skill")
  );
  await writeFile(
    path.join(confinedPlugin, "components", "outside", "SKILL.md"),
    skillDoc("name: Leaked Component Skill")
  );

  await writeFile(path.join(codexHome, "plugins", "cache", "bad", "broken", "1.0.0", ".codex-plugin", "plugin.json"), "{");
  await writeFile(
    path.join(codexHome, "config.toml"),
    `[plugins."enabled@sisyphuslabs"]\nenabled = true\n\n[plugins."disabled@openai-curated"]\nenabled = false\n\n[plugins."cached@marketplace"]\nenabled = "true"\n\n[plugins.bad\nenabled = true\n`
  );

  return { codexHome };
}

async function writePlugin({ codexHome, marketplace, pluginDir, skillDir, skillName, skillDescription }) {
  const pluginRoot = path.join(codexHome, "plugins", "cache", marketplace, pluginDir, "1.0.0");
  await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: pluginDir, skills: "./skills" }));
  await writeFile(
    path.join(pluginRoot, "skills", skillDir, "SKILL.md"),
    skillDoc(`name: ${skillName}`, `description: ${skillDescription}`)
  );
  await writeFile(path.join(pluginRoot, "skills", skillDir, "nested", "SKILL.md"), skillDoc("name: Nested Plugin Skill"));
}
