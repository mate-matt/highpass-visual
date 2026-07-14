import { describe, expect, test } from "vitest";

import {
  createSystemCommandProbe,
  inspectRuntime,
  type CommandProbe,
  type CommandResult
} from "../src/runtime-inspection.js";

function probeWith(results: Record<string, CommandResult>): CommandProbe {
  return {
    async run(command, args = []) {
      const key = args[0] === "-c"
        ? `${command} -c highpass-runtime-inspection`
        : command === "google-chrome" && args.includes("--dump-dom")
          ? "google-chrome highpass-capture-probe"
        : [command, ...args].join(" ");
      return results[key] ?? { ok: false, stdout: "", stderr: `missing fixture: ${key}` };
    }
  };
}

const readyResults: Record<string, CommandResult> = {
  "node --version": { ok: true, stdout: "v24.14.1\n", stderr: "" },
  "python3 --version": { ok: true, stdout: "Python 3.12.2\n", stderr: "" },
  "python3 -c highpass-runtime-inspection": {
    ok: true,
    stdout: '{"version":"4.13.0","ximgproc":{"thinning":true}}\n',
    stderr: ""
  },
  "ffmpeg -version": {
    ok: true,
    stdout: "ffmpeg version 7.1 Copyright (c) FFmpeg developers\n",
    stderr: ""
  },
  "ffprobe -version": {
    ok: true,
    stdout: "ffprobe version 7.1 Copyright (c) FFmpeg developers\n",
    stderr: ""
  },
  "google-chrome --version": {
    ok: true,
    stdout: "Google Chrome 149.0.0.0\n",
    stderr: ""
  },
  "google-chrome highpass-capture-probe": {
    ok: true,
    stdout: '<html><body data-highpass-canvas="ready"><canvas></canvas></body></html>\n',
    stderr: ""
  }
};

describe("runtime inspection", () => {
  test("reports a ready runtime when every required capability is available", async () => {
    const report = await inspectRuntime(probeWith(readyResults), {
      browserCommands: ["google-chrome"]
    });

    expect(report.status).toBe("ready");
    expect(report.capabilities).toEqual([
      expect.objectContaining({ id: "node", available: true, required: true, version: "24.14.1" }),
      expect.objectContaining({ id: "python", available: true, required: true, version: "3.12.2" }),
      expect.objectContaining({ id: "opencv", available: true, required: true, version: "4.13.0" }),
      expect.objectContaining({ id: "opencv-ximgproc", available: true, required: false }),
      expect.objectContaining({ id: "ffmpeg", available: true, required: true, version: "7.1" }),
      expect.objectContaining({ id: "ffprobe", available: true, required: true, version: "7.1" }),
      expect.objectContaining({ id: "browser-capture", available: true, required: true, version: "149.0.0.0" }),
      expect.objectContaining({ id: "transition-renderer", available: true, required: true, features: { canvas2d: true, webgl2: false } })
    ]);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test("degrades with an actionable fallback when ximgproc is unavailable", async () => {
    const report = await inspectRuntime(
      probeWith({
        ...readyResults,
        "python3 -c highpass-runtime-inspection": {
          ok: true,
          stdout: '{"version":"4.13.0","ximgproc":{"thinning":false}}\n',
          stderr: ""
        }
      }),
      { browserCommands: ["google-chrome"] }
    );

    expect(report.status).toBe("degraded");
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([
      "OpenCV ximgproc thinning is unavailable; Open Stroke extraction will use the declared morphological skeleton fallback."
    ]);
  });

  test("blocks with an actionable message when Python is unavailable", async () => {
    const report = await inspectRuntime(
      probeWith({
        ...readyResults,
        "python3 --version": { ok: false, stdout: "", stderr: "command not found" },
        "python3 -c highpass-runtime-inspection": { ok: false, stdout: "", stderr: "command not found" }
      }),
      { browserCommands: ["google-chrome"] }
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain(
      "Python 3.10 or newer is required to compile Vision Assets. Create the plugin's isolated runtime with npm run python:setup."
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({ id: "python", available: false, required: true })
    );
  });

  test("blocks when Node exists but is older than the supported major version", async () => {
    const report = await inspectRuntime(
      probeWith({
        ...readyResults,
        "node --version": { ok: true, stdout: "v18.20.8\n", stderr: "" }
      }),
      { browserCommands: ["google-chrome"] }
    );

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain(
      "Node.js 20 or newer is required to run the Highpass Visual MCP server."
    );
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({ id: "node", available: false, version: "18.20.8" })
    );
  });

  test("blocks before publication when FFprobe is unavailable", async () => {
    const report = await inspectRuntime(probeWith({
      ...readyResults,
      "ffprobe -version": { ok: false, stdout: "", stderr: "command not found" }
    }), { browserCommands: ["google-chrome"] });
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("FFprobe is required to inspect and verify film deliveries.");
  });

  test("uses an explicitly selected managed Python runtime and rejects older Python", async () => {
    const managed = await inspectRuntime(
      probeWith({
        ...readyResults,
        "managed-python --version": { ok: true, stdout: "Python 3.13.1\n", stderr: "" },
        "managed-python -c highpass-runtime-inspection": readyResults["python3 -c highpass-runtime-inspection"]
      }),
      { browserCommands: ["google-chrome"], pythonCommands: ["managed-python"] }
    );
    expect(managed.status).toBe("ready");
    expect(managed.capabilities).toContainEqual(
      expect.objectContaining({ id: "python", available: true, version: "3.13.1" })
    );

    const outdated = await inspectRuntime(
      probeWith({ ...readyResults, "python3 --version": { ok: true, stdout: "Python 3.8.10\n", stderr: "" } }),
      { browserCommands: ["google-chrome"], pythonCommands: ["python3"] }
    );
    expect(outdated.status).toBe("blocked");
    expect(outdated.capabilities).toContainEqual(
      expect.objectContaining({ id: "python", available: false, version: "3.8.10" })
    );
  });

  test("allows a longer cold-start window for the OpenCV import probe", async () => {
    const fixture = probeWith(readyResults);
    const opencvTimeouts: Array<number | undefined> = [];
    const recordingProbe: CommandProbe = {
      async run(command, args = [], options = {}) {
        if (args[0] === "-c") opencvTimeouts.push(options.timeoutMs);
        return fixture.run(command, args, options);
      }
    };

    const report = await inspectRuntime(recordingProbe, {
      browserCommands: ["google-chrome"],
      pythonCommands: ["python3"]
    });

    expect(report.status).toBe("ready");
    expect(opencvTimeouts).toEqual([60_000]);
  });

  test("rejects a browser command that cannot complete the headless Canvas handshake", async () => {
    const report = await inspectRuntime(
      probeWith({
        ...readyResults,
        "google-chrome highpass-capture-probe": {
          ok: true,
          stdout: "<html><body>no canvas marker</body></html>",
          stderr: ""
        }
      }),
      { browserCommands: ["google-chrome"] }
    );

    expect(report.status).toBe("blocked");
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({ id: "browser-capture", available: false, version: "149.0.0.0" })
    );
  });

  test("bounds external command time and captured output", async () => {
    const probe = createSystemCommandProbe({ timeoutMs: 50, maxOutputBytes: 32 });
    const result = await probe.run(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(1000)); setInterval(() => {}, 1000)"
    ]);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32);
  });
});
