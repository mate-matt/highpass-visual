import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.HIGHPASS_BOOTSTRAP_PYTHON,
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3"
].filter(Boolean);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });
  return result;
}

let selected;
for (const command of candidates) {
  const result = run(command, ["--version"], { capture: true });
  const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
  if (result.status === 0 && version) {
    const major = Number(version[1]);
    const minor = Number(version[2]);
    if (major > 3 || (major === 3 && minor >= 10)) {
      selected = { command, version: `${version[1]}.${version[2]}.${version[3]}` };
      break;
    }
  }
}

if (!selected) {
  throw new Error("Highpass Visual requires Python 3.10 or newer to create its isolated Vision Compiler environment.");
}

const venvRoot = path.join(pluginRoot, ".venv");
if (existsSync(venvRoot)) rmSync(venvRoot, { recursive: true, force: true });
console.log(`Creating isolated Vision Compiler environment with Python ${selected.version}`);
let result = run(selected.command, ["-m", "venv", venvRoot]);
if (result.status !== 0) process.exit(result.status ?? 1);

const venvPython = process.platform === "win32"
  ? path.join(venvRoot, "Scripts", "python.exe")
  : path.join(venvRoot, "bin", "python");
result = run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
if (result.status !== 0) process.exit(result.status ?? 1);
result = run(venvPython, ["-m", "pip", "install", "-r", path.join(pluginRoot, "python", "requirements.txt")]);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`PASS: isolated Vision Compiler runtime is ready at ${venvPython}`);
