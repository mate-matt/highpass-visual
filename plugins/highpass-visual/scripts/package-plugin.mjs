import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateContractAssets } from "./generate-contract-assets.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFlag = process.argv.indexOf("--output");
const outputRoot = path.resolve(outputFlag >= 0 && process.argv[outputFlag + 1]
  ? process.argv[outputFlag + 1]
  : path.join(pluginRoot, "release", "highpass-visual"));
const dedicatedReleaseRoot = path.join(pluginRoot, "release");
if (outputRoot === pluginRoot || pluginRoot.startsWith(`${outputRoot}${path.sep}`)) {
  throw new Error("Package output must not replace or contain the plugin source directory.");
}
if (outputRoot.startsWith(`${pluginRoot}${path.sep}`) && !outputRoot.startsWith(`${dedicatedReleaseRoot}${path.sep}`)) {
  throw new Error("Package output inside the plugin source is allowed only under its dedicated release directory.");
}

await generateContractAssets(pluginRoot);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const allowlist = [
  ".codex-plugin",
  ".mcp.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "browsers.json",
  "package.json",
  "dist",
  "examples",
  "presets",
  "schemas",
  "python/requirements.txt",
  "python/vision_compiler.py",
  "python/transition_compiler.py",
  "runtime",
  "scripts/setup-python.mjs",
  "skills"
];
for (const relative of allowlist) {
  await cp(path.join(pluginRoot, relative), path.join(outputRoot, relative), { recursive: true });
}
const sourcePackage = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
await writeFile(path.join(outputRoot, "package.json"), `${JSON.stringify({
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  type: "module",
  engines: sourcePackage.engines,
  scripts: { "python:setup": "node scripts/setup-python.mjs" }
}, null, 2)}\n`);

const lock = JSON.parse(await readFile(path.join(pluginRoot, "package-lock.json"), "utf8"));
const metafile = JSON.parse(await readFile(path.join(pluginRoot, "dist", "metafile-cjs.json"), "utf8"));
const packagePaths = Object.keys(lock.packages)
  .filter((packagePath) => packagePath.startsWith("node_modules/"))
  .sort((left, right) => right.length - left.length);
const bundledPackagePaths = new Set();
for (const inputPath of Object.keys(metafile.inputs)) {
  const owner = packagePaths.find((packagePath) => inputPath === packagePath || inputPath.startsWith(`${packagePath}/`));
  if (owner) bundledPackagePaths.add(owner);
}
const licenseIndex = [];
for (const packagePath of [...bundledPackagePaths].sort()) {
  const metadata = lock.packages[packagePath];
  const packageName = packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
  const sourceDirectory = path.join(pluginRoot, packagePath);
  let candidates;
  try {
    candidates = (await readdir(sourceDirectory)).filter((name) => /^(?:licen[cs]e|copying)(?:\..+)?$/i.test(name)).sort();
  } catch {
    continue;
  }
  if (!candidates.length) throw new Error(`Bundled package ${packageName}@${metadata.version} has no distributable license file.`);
  const identity = `${packageName.replaceAll("/", "__")}@${metadata.version}`;
  const targetDirectory = path.join(outputRoot, "licenses", "node", identity);
  await mkdir(targetDirectory, { recursive: true });
  for (const candidate of candidates) await cp(path.join(sourceDirectory, candidate), path.join(targetDirectory, candidate));
  licenseIndex.push({
    name: packageName,
    version: metadata.version,
    declaredLicense: metadata.license ?? "see bundled license",
    files: candidates.map((candidate) => `licenses/node/${identity}/${candidate}`)
  });
}
licenseIndex.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
await mkdir(path.join(outputRoot, "licenses", "node"), { recursive: true });
await writeFile(path.join(outputRoot, "licenses", "node", "index.json"), `${JSON.stringify(licenseIndex, null, 2)}\n`);
await writeFile(path.join(outputRoot, "licenses", "node", "bundle-inputs.json"), `${JSON.stringify({
  schemaVersion: "highpass.bundled-node-packages.v1",
  packages: [...bundledPackagePaths].sort().map((packagePath) => {
    const metadata = lock.packages[packagePath];
    return {
      name: packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length),
      version: metadata.version
    };
  })
}, null, 2)}\n`);
await rm(path.join(outputRoot, "dist", "metafile-cjs.json"), { force: true });

async function filesBelow(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const fileStat = await lstat(path.join(root, relative));
    if (fileStat.isSymbolicLink()) throw new Error(`Release packages cannot contain symbolic links: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else files.push(relative.split(path.sep).join("/"));
  }
  return files.sort();
}

const files = await filesBelow(outputRoot);
const entries = [];
for (const relative of files) {
  const bytes = await readFile(path.join(outputRoot, relative));
  entries.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const pluginManifest = JSON.parse(await readFile(path.join(outputRoot, ".codex-plugin", "plugin.json"), "utf8"));
await writeFile(path.join(outputRoot, "release-manifest.json"), `${JSON.stringify({
  schemaVersion: "highpass.release-manifest.v1",
  plugin: { name: pluginManifest.name, version: pluginManifest.version },
  files: entries
}, null, 2)}\n`);
console.log(`PASS: packaged ${entries.length} allowlisted files at ${outputRoot}`);
