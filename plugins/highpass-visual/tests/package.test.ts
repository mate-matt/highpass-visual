import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { DeliveryProfileSchema } from "../src/publication-pipeline.js";
import { VisionRecipeSchema } from "../src/vision-compiler.js";

async function filesBelow(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else files.push(relative.split(path.sep).join("/"));
  }
  return files.sort();
}

describe("distributable plugin package", () => {
  let root: string;
  let releaseRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-package-test-"));
    releaseRoot = path.join(root, "highpass-visual");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("builds an allowlisted, documented, self-describing plugin that starts cleanly", async () => {
    const packaged = spawnSync(process.execPath, ["scripts/package-plugin.mjs", "--output", releaseRoot], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(packaged.status, `${packaged.stdout}\n${packaged.stderr}`).toBe(0);
    const files = await filesBelow(releaseRoot);
    for (const required of [
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "dist/mcp-server.cjs",
      "examples/director/the-signal/director-draft.json",
      "presets/delivery-profiles.json",
      "presets/vision-recipes.json",
      "presets/transition-quality-gates.json",
      "schemas/mcp-tools.schema.json",
      "skills/direct-story-films/SKILL.md",
      "python/transition_compiler.py",
      "release-manifest.json"
    ]) expect(files).toContain(required);
    expect(files.some((file) => /(^|\/)(node_modules|\.venv|src|tests)(\/|$)/.test(file))).toBe(false);
    expect(files.some((file) => file.endsWith(".pyc") || file.includes("__pycache__"))).toBe(false);

    const bundledRuntime = await readFile(path.join(releaseRoot, "dist/mcp-server.cjs"), "utf8");
    expect(bundledRuntime).not.toMatch(/\/Users\/|[A-Z]:\\Users\\/);

    const allText = (await Promise.all(files.filter((file) => /\.(?:json|md|yaml|mjs|py)$/.test(file) || ["LICENSE", ".mcp.json"].includes(file))
      .map((file) => readFile(path.join(releaseRoot, file), "utf8")))).join("\n");
    expect(allText).not.toMatch(/\/Users\/saint|highpass-package-test-/);

    const pluginManifest = JSON.parse(await readFile(path.join(releaseRoot, ".codex-plugin/plugin.json"), "utf8"));
    expect(pluginManifest).toMatchObject({
      name: "highpass-visual",
      version: expect.stringMatching(/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/),
      skills: "./skills/",
      mcpServers: "./.mcp.json"
    });
    expect(existsSync(path.resolve(releaseRoot, pluginManifest.skills))).toBe(true);
    expect(existsSync(path.resolve(releaseRoot, pluginManifest.mcpServers))).toBe(true);
    const mcpManifest = JSON.parse(await readFile(path.join(releaseRoot, ".mcp.json"), "utf8"));
    const mcp = mcpManifest.mcpServers["highpass-visual"];
    expect(mcp).toMatchObject({ command: "node", cwd: "." });
    expect(existsSync(path.resolve(releaseRoot, mcp.args[0]))).toBe(true);
    const skillRoot = path.join(releaseRoot, "skills/direct-story-films");
    const skillText = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skillText).toMatch(/^---\nname: direct-story-films\ndescription: .+\n---\n/);
    for (const markdownPath of files.filter((file) => file.startsWith("skills/") && file.endsWith(".md"))) {
      const markdown = await readFile(path.join(releaseRoot, markdownPath), "utf8");
      for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        const reference = match[1];
        if (/^(?:https?:|#)/.test(reference)) continue;
        expect(existsSync(path.resolve(releaseRoot, path.dirname(markdownPath), reference)), `missing Skill reference ${reference}`).toBe(true);
      }
    }

    const deliveryProfiles = JSON.parse(await readFile(path.join(releaseRoot, "presets/delivery-profiles.json"), "utf8"));
    expect(deliveryProfiles.profiles.map((profile: unknown) => DeliveryProfileSchema.parse(profile))).toHaveLength(4);
    const visionRecipes = JSON.parse(await readFile(path.join(releaseRoot, "presets/vision-recipes.json"), "utf8"));
    expect(visionRecipes.recipes.map(({ recipe }: { recipe: unknown }) => VisionRecipeSchema.parse(recipe))).toHaveLength(3);
    const schemas = JSON.parse(await readFile(path.join(releaseRoot, "schemas/mcp-tools.schema.json"), "utf8"));
    expect(Object.keys(schemas.tools).sort()).toEqual([
      "compile_director_project",
      "compile_transition_asset",
      "compile_vision_asset",
      "inspect_runtime",
      "prepare_ink_reveal_preview",
      "prepare_transition_program",
      "prepare_treatment_comparison",
      "publish_shot",
      "publish_story"
    ]);

    const manifest = JSON.parse(await readFile(path.join(releaseRoot, "release-manifest.json"), "utf8"));
    expect(manifest.files).toHaveLength(files.length - 1);
    expect(manifest.files.every(({ path: file, sha256 }: { path: string; sha256: string }) => files.includes(file) && /^[a-f0-9]{64}$/.test(sha256))).toBe(true);

    const bundledPackages = JSON.parse(await readFile(path.join(releaseRoot, "licenses/node/bundle-inputs.json"), "utf8"));
    const licenseIndex = JSON.parse(await readFile(path.join(releaseRoot, "licenses/node/index.json"), "utf8"));
    expect(bundledPackages.packages.map(({ name, version }: { name: string; version: string }) => `${name}@${version}`).sort()).toEqual(
      licenseIndex.map(({ name, version }: { name: string; version: string }) => `${name}@${version}`).sort()
    );
    expect(licenseIndex.map(({ name }: { name: string }) => name)).toContain("mitt");

    expect(existsSync(path.join(releaseRoot, "dist/mcp-server.cjs"))).toBe(true);
    const client = new Client({ name: "clean-package-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/mcp-server.cjs"],
      cwd: releaseRoot,
      stderr: "pipe"
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("publish_story");
      const inspection = await client.callTool({ name: "inspect_runtime", arguments: {} });
      expect(inspection.isError).not.toBe(true);
      expect(inspection.structuredContent).toEqual({ result: expect.objectContaining({ capabilities: expect.any(Array) }) });
    } finally {
      await client.close();
    }
  }, 30_000);

  test("refuses to delete an arbitrary source subdirectory as package output", () => {
    const pythonDirectory = path.resolve("python");
    const packaged = spawnSync(process.execPath, ["scripts/package-plugin.mjs", "--output", pythonDirectory], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(packaged.status).not.toBe(0);
    expect(existsSync(path.join(pythonDirectory, "vision_compiler.py"))).toBe(true);
  });
});
