import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  truncated?: boolean;
};

export type CommandProbeOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type CommandProbe = {
  run(command: string, args?: string[], options?: CommandProbeOptions): Promise<CommandResult>;
};

export const RuntimeCapabilitySchema = z.object({
  id: z.enum(["node", "python", "opencv", "opencv-ximgproc", "ffmpeg", "ffprobe", "browser-capture", "transition-renderer"]),
  label: z.string(),
  required: z.boolean(),
  available: z.boolean(),
  version: z.string().nullable(),
  detail: z.string(),
  features: z.record(z.string(), z.boolean()).optional()
});

export const RuntimeReportSchema = z.object({
  status: z.enum(["ready", "degraded", "blocked"]),
  capabilities: z.array(RuntimeCapabilitySchema),
  blockers: z.array(z.string()),
  warnings: z.array(z.string())
});

export const RuntimeToolOutputSchema = z.object({ result: RuntimeReportSchema });

export type RuntimeCapabilityId = z.infer<typeof RuntimeCapabilitySchema>["id"];
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;
export type RuntimeReport = z.infer<typeof RuntimeReportSchema>;

export type RuntimeInspectionOptions = {
  browserCommands?: string[];
  pythonCommands?: string[];
};

type XimgprocFeatures = {
  thinning: boolean;
};

const OPENCV_INSPECTION_PROGRAM = [
  "import cv2, json",
  "x=getattr(cv2, 'ximgproc', None)",
  "features={'thinning': callable(getattr(x, 'thinning', None))}",
  "print(json.dumps({'version': cv2.__version__, 'ximgproc': features}))"
].join("; ");

const BROWSER_VERSION_PATTERN = /(?:Google Chrome(?: for Testing)?|Chrome|Chromium|Microsoft Edge|Edge)\/?\s+([0-9][^\s]*)/i;
const BROWSER_CAPTURE_MARKER = 'data-highpass-canvas="ready"';
const BROWSER_CAPTURE_PROBE_URL = `data:text/html,${encodeURIComponent(
  '<!doctype html><body><canvas id="c" width="2" height="2"></canvas><script>const c=document.getElementById("c");const x=c.getContext("2d");x.fillRect(0,0,2,2);if(x.getImageData(0,0,1,1).data[3]===255)document.body.dataset.highpassCanvas="ready";document.body.dataset.highpassWebgl2=c.getContext("webgl2")?"ready":"unavailable";</script></body>'
)}`;
const BROWSER_CAPTURE_ARGS = [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-networking",
  "--no-first-run",
  "--no-default-browser-check",
  "--dump-dom",
  BROWSER_CAPTURE_PROBE_URL
];

function managedBrowserCommands() {
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright") : null,
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ms-playwright") : null,
    process.platform === "linux" ? path.join(os.homedir(), ".cache", "ms-playwright") : null
  ].filter((value): value is string => Boolean(value && value !== "0" && existsSync(value)));
  const commands: string[] = [];
  for (const cacheRoot of cacheRoots) {
    const builds = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    for (const build of builds) {
      const buildRoot = path.join(cacheRoot, build.name);
      for (const platformDirectory of readdirSync(buildRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        for (const executableName of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const candidate = path.join(buildRoot, platformDirectory.name, executableName);
          if (existsSync(candidate)) commands.push(candidate);
        }
      }
    }
  }
  return [...new Set(commands)];
}

export const DEFAULT_BROWSER_COMMANDS = [
  process.env.HIGHPASS_BROWSER_EXECUTABLE,
  ...managedBrowserCommands(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "google-chrome",
  "chromium",
  "chromium-browser"
].filter((value): value is string => Boolean(value));

export function resolveLocalExecutable(command: string): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return existsSync(command) ? path.resolve(command) : null;
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
const DEFAULT_PYTHON_COMMANDS = [
  process.env.HIGHPASS_PYTHON,
  process.platform === "win32"
    ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
    : path.join(process.cwd(), ".venv", "bin", "python"),
  "python3"
].filter((value): value is string => Boolean(value));

function versionFrom(pattern: RegExp, value: string): string | null {
  return value.match(pattern)?.[1] ?? null;
}

function capability(
  id: RuntimeCapabilityId,
  label: string,
  required: boolean,
  available: boolean,
  version: string | null,
  detail: string,
  features?: Record<string, boolean>
): RuntimeCapability {
  return { id, label, required, available, version, detail, ...(features ? { features } : {}) };
}

function appendBounded(current: string, chunk: unknown, maxBytes: number) {
  const currentBytes = Buffer.byteLength(current);
  const incoming = Buffer.from(String(chunk));
  const remaining = Math.max(0, maxBytes - currentBytes);
  return {
    value: current + incoming.subarray(0, remaining).toString(),
    truncated: incoming.byteLength > remaining
  };
}

export function createSystemCommandProbe(defaults: Required<CommandProbeOptions> = {
  timeoutMs: 10_000,
  maxOutputBytes: 65_536
}): CommandProbe {
  return {
    run(command, args = [], options = {}) {
      const timeoutMs = options.timeoutMs ?? defaults.timeoutMs;
      const maxOutputBytes = options.maxOutputBytes ?? defaults.maxOutputBytes;
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let truncated = false;
        let settled = false;

        const finish = (code: number | null, error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            const appended = appendBounded(stderr, error.message, maxOutputBytes);
            stderr = appended.value;
            truncated ||= appended.truncated;
          }
          resolve({ ok: code === 0 && !timedOut && !error, stdout, stderr, timedOut, truncated });
        };

        child.stdout.on("data", (chunk) => {
          const appended = appendBounded(stdout, chunk, maxOutputBytes);
          stdout = appended.value;
          truncated ||= appended.truncated;
        });
        child.stderr.on("data", (chunk) => {
          const appended = appendBounded(stderr, chunk, maxOutputBytes);
          stderr = appended.value;
          truncated ||= appended.truncated;
        });
        child.on("error", (error) => finish(null, error));
        child.on("close", (code) => finish(code));

        const timer = setTimeout(() => {
          timedOut = true;
          if (!child.kill("SIGKILL")) finish(null);
        }, timeoutMs);
      });
    }
  };
}

export const systemCommandProbe = createSystemCommandProbe();

type BrowserInspection = {
  command: string | null;
  version: string | null;
  captureResult: CommandResult | null;
};

type PythonInspection = {
  command: string | null;
  result: CommandResult;
  version: string | null;
  supported: boolean;
};

async function inspectPython(probe: CommandProbe, commands: string[]): Promise<PythonInspection> {
  for (const command of commands) {
    const result = await probe.run(command, ["--version"]);
    const version = result.ok
      ? versionFrom(/Python\s+([^\s]+)/m, result.stdout || result.stderr)
      : null;
    if (!version) continue;
    const [major = 0, minor = 0] = version.split(".").map(Number);
    return { command, result, version, supported: major > 3 || (major === 3 && minor >= 10) };
  }
  return {
    command: null,
    result: { ok: false, stdout: "", stderr: "No supported Python command was found." },
    version: null,
    supported: false
  };
}

async function inspectBrowser(probe: CommandProbe, commands: string[]): Promise<BrowserInspection> {
  let recognizedFailure: BrowserInspection | null = null;
  for (const command of commands) {
    let version: string | null = null;
    if (process.platform === "darwin" && path.isAbsolute(command)) {
      const applicationContents = path.resolve(path.dirname(command), "..");
      const frameworkNames = ["Google Chrome Framework.framework", "Chromium Framework.framework", "Microsoft Edge Framework.framework"];
      for (const frameworkName of frameworkNames) {
        const versions = path.join(applicationContents, "Frameworks", frameworkName, "Versions");
        if (!existsSync(versions)) continue;
        version = readdirSync(versions)
          .filter((entry) => entry !== "Current" && /^\d/.test(entry))
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
          .at(-1) ?? null;
        if (version) break;
      }
    }
    if (!version) {
      const versionResult = await probe.run(command, ["--version"]);
      const versionOutput = versionResult.stdout || versionResult.stderr;
      version = versionResult.ok ? versionFrom(BROWSER_VERSION_PATTERN, versionOutput) : null;
      if (!version) continue;
    }

    const captureResult = await probe.run(command, BROWSER_CAPTURE_ARGS);
    const inspection = { command, version, captureResult };
    if (captureResult.ok && captureResult.stdout.includes(BROWSER_CAPTURE_MARKER)) return inspection;
    recognizedFailure ??= inspection;
  }
  return recognizedFailure ?? { command: null, version: null, captureResult: null };
}

export async function inspectRuntime(
  probe: CommandProbe = systemCommandProbe,
  options: RuntimeInspectionOptions = {}
): Promise<RuntimeReport> {
  const [nodeResult, python, ffmpegResult, ffprobeResult, browser] = await Promise.all([
    probe.run("node", ["--version"]),
    inspectPython(probe, options.pythonCommands ?? DEFAULT_PYTHON_COMMANDS),
    probe.run("ffmpeg", ["-version"]),
    probe.run("ffprobe", ["-version"]),
    inspectBrowser(probe, options.browserCommands ?? DEFAULT_BROWSER_COMMANDS)
  ]);

  const opencvResult = python.supported && python.command
    ? await probe.run(python.command, ["-c", OPENCV_INSPECTION_PROGRAM], { timeoutMs: 60_000 })
    : { ok: false, stdout: "", stderr: "Supported Python unavailable" };

  let opencvVersion: string | null = null;
  let ximgprocFeatures: XimgprocFeatures = {
    thinning: false
  };
  if (opencvResult.ok) {
    try {
      const parsed = JSON.parse(opencvResult.stdout.trim()) as {
        version?: unknown;
        ximgproc?: Partial<XimgprocFeatures>;
      };
      opencvVersion = typeof parsed.version === "string" ? parsed.version : null;
      ximgprocFeatures = {
        thinning: parsed.ximgproc?.thinning === true
      };
    } catch {
      opencvVersion = null;
    }
  }

  const nodeVersion = versionFrom(/^v([^\s]+)/m, nodeResult.stdout);
  const nodeMajor = nodeVersion ? Number.parseInt(nodeVersion.split(".")[0] ?? "", 10) : Number.NaN;
  const nodeAvailable = nodeResult.ok && Number.isFinite(nodeMajor) && nodeMajor >= 20;
  const ximgprocAvailable = Object.values(ximgprocFeatures).every(Boolean);
  const browserAvailable = browser.captureResult?.ok === true
    && browser.captureResult.stdout.includes(BROWSER_CAPTURE_MARKER);
  const webgl2Available = browserAvailable && browser.captureResult!.stdout.includes('data-highpass-webgl2="ready"');
  const capabilities: RuntimeCapability[] = [
    capability(
      "node", "Node.js", true, nodeAvailable, nodeVersion,
      nodeAvailable ? "Runs the MCP facade and browser publication orchestration." : "Node.js 20 or newer was not found."
    ),
    capability(
      "python", "Python", true, python.supported, python.version,
      python.supported
        ? `Runs the native Vision Compiler worker with ${python.command}.`
        : "Python 3.10 or newer was not found."
    ),
    capability(
      "opencv", "OpenCV", true, opencvResult.ok && opencvVersion !== null, opencvVersion,
      opencvResult.ok && opencvVersion ? "Compiles deterministic Vision Assets." : "The Python cv2 module could not be imported."
    ),
    capability(
      "opencv-ximgproc", "OpenCV ximgproc", false, ximgprocAvailable, opencvVersion,
      ximgprocAvailable
        ? "Provides thinning for ordered Open Stroke extraction."
        : "Open Stroke extraction uses a declared morphological skeleton fallback.",
      ximgprocFeatures
    ),
    capability(
      "ffmpeg", "FFmpeg", true, ffmpegResult.ok,
      versionFrom(/ffmpeg version\s+([^\s]+)/m, ffmpegResult.stdout || ffmpegResult.stderr),
      ffmpegResult.ok ? "Encodes frames and assembles delivery media." : "FFmpeg was not found."
    ),
    capability(
      "ffprobe", "FFprobe", true, ffprobeResult.ok,
      versionFrom(/ffprobe version\s+([^\s]+)/m, ffprobeResult.stdout || ffprobeResult.stderr),
      ffprobeResult.ok ? "Inspects encoded media and verifies Quality Evidence." : "FFprobe was not found."
    ),
    capability(
      "browser-capture", "Browser capture", true, browserAvailable, browser.version,
      browserAvailable && browser.command
        ? `Completed a headless Canvas handshake with ${browser.command}.`
        : browser.command
          ? `Found ${browser.command}, but its headless Canvas handshake failed.`
          : "No supported Chromium browser executable was found."
    ),
    capability(
      "transition-renderer", "Transition renderer", true, browserAvailable, browser.version,
      browserAvailable
        ? webgl2Available
          ? "Deterministic Canvas transition delivery is ready; WebGL2 acceleration is also available."
          : "Deterministic Canvas transition delivery is ready; WebGL2 acceleration is unavailable and is not required."
        : "Transition delivery requires the same deterministic headless Canvas runtime as Shot publication.",
      { canvas2d: browserAvailable, webgl2: webgl2Available }
    )
  ];

  const blockers: string[] = [];
  if (!nodeAvailable) blockers.push("Node.js 20 or newer is required to run the Highpass Visual MCP server.");
  if (!python.supported) blockers.push("Python 3.10 or newer is required to compile Vision Assets. Create the plugin's isolated runtime with npm run python:setup.");
  else if (!opencvResult.ok || !opencvVersion) blockers.push("OpenCV for Python is required to compile Vision Assets. Install opencv-contrib-python-headless.");
  if (!ffmpegResult.ok) blockers.push("FFmpeg is required to publish film deliveries.");
  if (!ffprobeResult.ok) blockers.push("FFprobe is required to inspect and verify film deliveries.");
  if (!browserAvailable) blockers.push("A Chromium-based browser that passes the headless Canvas handshake is required for deterministic frame capture.");

  const warnings = ximgprocAvailable || !opencvVersion
    ? []
    : ["OpenCV ximgproc thinning is unavailable; Open Stroke extraction will use the declared morphological skeleton fallback."];

  return RuntimeReportSchema.parse({
    status: blockers.length ? "blocked" : warnings.length ? "degraded" : "ready",
    capabilities,
    blockers,
    warnings
  });
}
