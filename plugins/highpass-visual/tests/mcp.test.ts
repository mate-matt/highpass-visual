import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";

import { createMcpServer } from "../src/mcp-server.js";
import type { CommandProbe, CommandResult } from "../src/runtime-inspection.js";
import { DEFAULT_VISION_RECIPE, VisionCompilerError } from "../src/vision-compiler.js";

function readyProbe(): CommandProbe {
  const results: Record<string, CommandResult> = {
    "node --version": { ok: true, stdout: "v24.14.1\n", stderr: "" },
    "python3 --version": { ok: true, stdout: "Python 3.12.2\n", stderr: "" },
    "python3 -c": { ok: true, stdout: '{"version":"4.13.0","ximgproc":{"thinning":true}}\n', stderr: "" },
    "ffmpeg -version": { ok: true, stdout: "ffmpeg version 7.1 Copyright\n", stderr: "" },
    "ffprobe -version": { ok: true, stdout: "ffprobe version 7.1 Copyright\n", stderr: "" },
    "google-chrome --version": { ok: true, stdout: "Google Chrome 149.0.0.0\n", stderr: "" },
    "google-chrome capture": { ok: true, stdout: '<body data-highpass-canvas="ready"></body>\n', stderr: "" }
  };

  return {
    async run(command, args = []) {
      const key = command === "python3" && args[0] === "-c"
        ? "python3 -c"
        : command === "google-chrome" && args.includes("--dump-dom")
          ? "google-chrome capture"
        : [command, ...args].join(" ");
      return results[key] ?? { ok: false, stdout: "", stderr: `missing fixture: ${key}` };
    }
  };
}

describe("Highpass Visual MCP server", () => {
  test("exposes runtime inspection as a structured read-only tool", async () => {
    const server = createMcpServer({
      runtimeProbe: readyProbe(),
      runtimeOptions: { browserCommands: ["google-chrome"] },
      visionCompiler: async () => ({
        manifestPath: "/tmp/vision/manifest.json",
        artifactHash: "a".repeat(64),
        cache: "miss"
      }),
      transitionCompiler: async () => ({
        manifestPath: "/tmp/transition/manifest.json",
        artifactHash: "b".repeat(64),
        selectedMethod: "cross-dissolve",
        cache: "miss"
      }),
      directorCompiler: async () => ({
        projectPath: "/tmp/director/director-project.json",
        directorHash: "9".repeat(64),
        cache: "miss"
      }),
      previewBuilder: async () => ({
        indexPath: "/tmp/preview/index.html",
        shotProgramPath: "/tmp/preview/shot-program.json",
        programHash: "c".repeat(64)
      }),
      comparisonBuilder: async () => ({
        indexPath: "/tmp/comparison/index.html",
        comparisonManifestPath: "/tmp/comparison/comparison-manifest.json",
        comparisonHash: "e".repeat(64),
        candidateProgramPaths: ["/tmp/ink.json", "/tmp/memory.json", "/tmp/etched.json"]
      }),
      transitionPreviewBuilder: async () => ({
        indexPath: "/tmp/transition-preview/index.html",
        transitionProgramPath: "/tmp/transition-preview/transition-program.json",
        programHash: "8".repeat(64),
        selectedMethod: "cross-dissolve"
      }),
      publisher: async () => ({
        status: "published",
        deliveryHash: "d".repeat(64),
        mp4Path: "/tmp/delivery/delivery.mp4",
        frameManifestPath: "/tmp/delivery/frames-manifest.json",
        qualityEvidencePath: "/tmp/delivery/quality-evidence.json",
        expectedFrameCount: 300,
        renderedFrames: 300,
        reusedFrames: 0
      }),
      storyPublisher: async () => ({
        status: "published",
        storyHash: "f".repeat(64),
        mp4Path: "/tmp/story/story.mp4",
        qualityEvidencePath: "/tmp/story/quality-evidence.json",
        expectedFrameCount: 600,
        shots: [{
          shotId: "shot-01",
          deliveryHash: "d".repeat(64),
          frameManifestPath: "/tmp/delivery/frames-manifest.json",
          qualityEvidencePath: "/tmp/delivery/quality-evidence.json",
          renderedFrames: 300,
          reusedFrames: 0
        }],
        transitions: []
      })
    });
    const client = new Client({ name: "highpass-visual-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      const tool = listed.tools.find(({ name }) => name === "inspect_runtime");
      const compileTool = listed.tools.find(({ name }) => name === "compile_vision_asset");
      const transitionCompileTool = listed.tools.find(({ name }) => name === "compile_transition_asset");
      const directorTool = listed.tools.find(({ name }) => name === "compile_director_project");
      const previewTool = listed.tools.find(({ name }) => name === "prepare_ink_reveal_preview");
      const comparisonTool = listed.tools.find(({ name }) => name === "prepare_treatment_comparison");
      const transitionProgramTool = listed.tools.find(({ name }) => name === "prepare_transition_program");
      const publishTool = listed.tools.find(({ name }) => name === "publish_shot");
      const publishStoryTool = listed.tools.find(({ name }) => name === "publish_story");
      expect(tool).toBeDefined();
      expect(compileTool?.outputSchema).toBeDefined();
      expect(transitionCompileTool?.outputSchema).toBeDefined();
      expect(directorTool?.outputSchema).toBeDefined();
      expect(previewTool?.outputSchema).toBeDefined();
      expect(comparisonTool?.outputSchema).toBeDefined();
      expect(transitionProgramTool?.outputSchema).toBeDefined();
      expect(publishTool?.outputSchema).toBeDefined();
      expect(publishStoryTool?.outputSchema).toBeDefined();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
      expect(tool?.outputSchema).toMatchObject({
        type: "object",
        properties: { result: expect.objectContaining({ type: "object" }) },
        required: ["result"]
      });

      const response = await client.callTool({ name: "inspect_runtime", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toEqual({
        result: expect.objectContaining({ status: "ready", blockers: [] })
      });

      const compiled = await client.callTool({
        name: "compile_vision_asset",
        arguments: {
          selectedImage: { id: "selected-01", path: "/tmp/selected.png", contentHash: "1".repeat(64) },
          recipe: DEFAULT_VISION_RECIPE,
          artifactRoot: "/tmp/artifacts"
        }
      });
      expect(compiled.structuredContent).toEqual({
        result: {
          manifestPath: "/tmp/vision/manifest.json",
          artifactHash: "a".repeat(64),
          cache: "miss"
        }
      });

      const compiledTransition = await client.callTool({
        name: "compile_transition_asset",
        arguments: {
          outgoingVisionManifestPath: "/tmp/vision-a/manifest.json",
          incomingVisionManifestPath: "/tmp/vision-b/manifest.json",
          transitionIntent: { intent: "continuity", duration: 1, reason: "Carry the related composition across the boundary." },
          artifactRoot: "/tmp/transitions"
        }
      });
      expect(compiledTransition.structuredContent).toEqual({ result: {
        manifestPath: "/tmp/transition/manifest.json",
        artifactHash: "b".repeat(64),
        selectedMethod: "cross-dissolve",
        cache: "miss"
      } });

      const directed = await client.callTool({
        name: "compile_director_project",
        arguments: { draftPath: "/tmp/director-draft.json", outputRoot: "/tmp/director" }
      });
      expect(directed.structuredContent).toEqual({
        result: {
          projectPath: "/tmp/director/director-project.json",
          directorHash: "9".repeat(64),
          cache: "miss"
        }
      });

      const preview = await client.callTool({
        name: "prepare_ink_reveal_preview",
        arguments: {
          shotId: "shot-01",
          attentionTarget: "the protagonist",
          duration: 10,
          visionAssetManifestPath: "/tmp/vision/manifest.json",
          outputDirectory: "/tmp/preview"
        }
      });
      expect(preview.structuredContent).toEqual({
        result: {
          indexPath: "/tmp/preview/index.html",
          shotProgramPath: "/tmp/preview/shot-program.json",
          programHash: "c".repeat(64)
        }
      });

      const published = await client.callTool({
        name: "publish_shot",
        arguments: {
          shotProgramPath: "/tmp/preview/shot-program.json",
          previewIndexPath: "/tmp/preview/index.html",
          deliveryProfile: {
            id: "portrait",
            width: 1080,
            height: 1920,
            fps: 30,
            codec: "h264",
            pixelFormat: "yuv420p"
          },
          outputRoot: "/tmp/deliveries"
        }
      });
      expect(published.structuredContent).toEqual({
        result: expect.objectContaining({
          deliveryHash: "d".repeat(64),
          expectedFrameCount: 300,
          mp4Path: "/tmp/delivery/delivery.mp4"
        })
      });

      const publishedStory = await client.callTool({
        name: "publish_story",
        arguments: {
          directorProjectPath: "/tmp/director/director-project.json",
          shots: [{
            shotId: "shot-01",
            shotProgramPath: "/tmp/preview/shot-program.json",
            previewIndexPath: "/tmp/preview/index.html"
          }],
          deliveryProfile: {
            id: "portrait",
            width: 1080,
            height: 1920,
            fps: 30,
            codec: "h264",
            pixelFormat: "yuv420p"
          },
          outputRoot: "/tmp/story-deliveries"
        }
      });
      expect(publishedStory.structuredContent).toEqual({
        result: expect.objectContaining({
          storyHash: "f".repeat(64),
          expectedFrameCount: 600,
          mp4Path: "/tmp/story/story.mp4"
        })
      });

      const compared = await client.callTool({
        name: "prepare_treatment_comparison",
        arguments: {
          shotId: "compare",
          attentionTarget: "center",
          duration: 10,
          seed: "same-seed",
          visionAssetManifestPath: "/tmp/vision/manifest.json",
          outputDirectory: "/tmp/comparison"
        }
      });
      expect(compared.structuredContent).toEqual({
        result: expect.objectContaining({
          comparisonHash: "e".repeat(64),
          candidateProgramPaths: expect.arrayContaining(["/tmp/ink.json", "/tmp/memory.json", "/tmp/etched.json"])
        })
      });

      const transitionProgram = await client.callTool({
        name: "prepare_transition_program",
        arguments: {
          outgoingShotProgramPath: "/tmp/outgoing/shot-program.json",
          outgoingPreviewIndexPath: "/tmp/outgoing/index.html",
          incomingShotProgramPath: "/tmp/incoming/shot-program.json",
          incomingPreviewIndexPath: "/tmp/incoming/index.html",
          transitionAssetManifestPath: "/tmp/transition/manifest.json",
          outputDirectory: "/tmp/transition-preview"
        }
      });
      expect(transitionProgram.structuredContent).toEqual({ result: {
        indexPath: "/tmp/transition-preview/index.html",
        transitionProgramPath: "/tmp/transition-preview/transition-program.json",
        programHash: "8".repeat(64),
        selectedMethod: "cross-dissolve"
      } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns sanitized Vision Compiler errors without worker diagnostics", async () => {
    const server = createMcpServer({
      runtimeProbe: readyProbe(),
      runtimeOptions: { browserCommands: ["google-chrome"] },
      visionCompiler: async () => {
        throw new VisionCompilerError("SOURCE_UNREADABLE", "The Selected Image could not be decoded by OpenCV.");
      }
    });
    const client = new Client({ name: "highpass-visual-error-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const response = await client.callTool({
        name: "compile_vision_asset",
        arguments: {
          selectedImage: { id: "selected-01", path: "/tmp/missing.png", contentHash: "1".repeat(64) },
          recipe: DEFAULT_VISION_RECIPE,
          artifactRoot: "/tmp/artifacts"
        }
      });
      const content = response.content as Array<{ type: string; text?: string }>;
      const text = content.find(({ type }) => type === "text")?.text ?? "";
      expect(response.isError).toBe(true);
      expect(text).toContain("SOURCE_UNREADABLE");
      expect(text).not.toMatch(/Traceback|spawn|python\/vision_compiler/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
