import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function generateContractAssets(pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const client = new Client({ name: "highpass-contract-export", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./dist/mcp-server.cjs"],
    cwd: pluginRoot,
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tools = Object.fromEntries(listed.tools
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description, inputSchema, outputSchema, annotations }) => [name, {
        description,
        inputSchema,
        outputSchema,
        annotations
      }]));
    const schemasRoot = path.join(pluginRoot, "schemas");
    await mkdir(schemasRoot, { recursive: true });
    const target = path.join(schemasRoot, "mcp-tools.schema.json");
    await writeFile(target, `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      schemaVersion: "highpass.mcp-contract-catalog.v1",
      tools
    }, null, 2)}\n`);
    return target;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = await generateContractAssets();
  console.log(`PASS: wrote MCP contract catalog to ${target}`);
}
