import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/mcp-server.cjs"],
  cwd: pluginRoot,
  stderr: "pipe"
});
const client = new Client({ name: "highpass-visual-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const requiredTools = ["inspect_runtime", "compile_director_project", "compile_vision_asset", "compile_transition_asset", "prepare_ink_reveal_preview", "prepare_treatment_comparison", "prepare_transition_program", "publish_shot", "publish_story"];
  const missingTools = requiredTools.filter((name) => !listed.tools.some((tool) => tool.name === name));
  if (missingTools.length) {
    throw new Error(`bundled MCP did not advertise ${missingTools.join(", ")}`);
  }
  const result = await client.callTool({ name: "inspect_runtime", arguments: {} });
  if (result.isError || !result.structuredContent) {
    throw new Error("inspect_runtime did not return structured content");
  }
  const report = result.structuredContent.result;
  console.log(`PASS: bundled MCP inspected runtime with status ${report.status}`);
  for (const blocker of report.blockers ?? []) console.log(`BLOCKER: ${blocker}`);
  for (const warning of report.warnings ?? []) console.log(`WARNING: ${warning}`);

  const opencvReady = report.capabilities?.some(({ id, available }) => id === "opencv" && available);
  if (opencvReady) {
    const root = await mkdtemp(resolve(tmpdir(), "highpass-mcp-smoke-"));
    try {
      const sourcePath = resolve(root, "selected.ppm");
      const width = 32;
      const height = 24;
      const pixels = Buffer.alloc(width * height * 3, 238);
      for (let y = 5; y < 19; y += 1) {
        for (let x = 7; x < 25; x += 1) {
          const offset = (y * width + x) * 3;
          pixels[offset] = 24;
          pixels[offset + 1] = 62;
          pixels[offset + 2] = 108;
        }
      }
      const sourceBytes = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
      await writeFile(sourcePath, sourceBytes);
      const compiled = await client.callTool({
        name: "compile_vision_asset",
        arguments: {
          selectedImage: { id: "smoke-selected-image", path: sourcePath, contentHash: createHash("sha256").update(sourceBytes).digest("hex") },
          recipe: {
            lowFrequencySigma: 3,
            strongEdges: { low: 96, high: 192 },
            detailEdges: { low: 28, high: 84 },
            minContourAreaRatio: 0.0005,
            simplifyEpsilonRatio: 0.0015,
            maxPaths: 2000,
            maxVertices: 30000
          },
          artifactRoot: resolve(root, "artifacts")
        }
      });
      if (compiled.isError) throw new Error("compile_vision_asset returned an error");
      const manifestPath = compiled.structuredContent.result.manifestPath;
      await access(manifestPath);
      console.log("PASS: bundled MCP compiled a fixture Vision Asset");
      const preview = await client.callTool({
        name: "prepare_ink_reveal_preview",
        arguments: {
          shotId: "smoke-shot",
          attentionTarget: "the central geometric figure",
          duration: 10,
          visionAssetManifestPath: manifestPath,
          outputDirectory: resolve(root, "preview")
        }
      });
      if (preview.isError) throw new Error("prepare_ink_reveal_preview returned an error");
      await access(preview.structuredContent.result.indexPath);
      console.log("PASS: bundled MCP prepared an Ink Reveal preview");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const publicationReady = ["browser-capture", "ffmpeg", "ffprobe"].every((id) =>
    report.capabilities?.some(({ id: capabilityId, available }) => capabilityId === id && available)
  );
  if (publicationReady) {
    const root = await mkdtemp(resolve(tmpdir(), "highpass-publication-smoke-"));
    try {
      const pngPath = resolve(root, "pixel.png");
      await writeFile(
        pngPath,
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZxZcAAAAASUVORK5CYII=", "base64")
      );
      const channelDefinitions = [
        ["low-frequency", "frequency-layer", "RGB low-frequency image"],
        ["signed-detail", "frequency-layer", "signed RGB detail offset by 128"],
        ["signed-detail-light", "frequency-layer", "positive signed detail RGB"],
        ["signed-detail-dark", "frequency-layer", "negative signed detail RGB"],
        ["strong-edge", "edge-layer", "8-bit edge mask"],
        ["detail-edge", "edge-layer", "8-bit detail edge mask"],
        ["subject-mask", "mask", "8-bit binary mask"],
        ["distance-field", "distance-field", "8-bit normalized distance field"],
        ["foreground-plate", "rgba-plate", "BGRA foreground with alpha mask"],
        ["middle-plate", "rgba-plate", "BGRA middle-frequency plate"],
        ["background-plate", "rgba-plate", "BGRA inpainted background plate"],
        ["depth-proxy", "depth-proxy", "8-bit mask-derived depth proxy"]
      ];
      const manifestPath = resolve(root, "vision-manifest.json");
      await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: "highpass.vision-asset.v1",
        artifactHash: "a".repeat(64),
        generator: {
          name: "highpass-vision-compiler",
          version: "smoke",
          opencvVersion: "smoke",
          numpyVersion: "smoke",
          features: { thinning: true }
        },
        provenance: {
          sourceHash: "b".repeat(64),
          parameterHash: "c".repeat(64),
          schemaHash: "d".repeat(64),
          generatorHash: "e".repeat(64),
          dependencyHash: "f".repeat(64)
        },
        source: {
          selectedImageId: "smoke-precompiled-image",
          path: pngPath,
          maskPath: null,
          imageHash: "b".repeat(64),
          maskHash: null,
          compiledPath: pngPath,
          previewPath: pngPath,
          width: 16,
          height: 16,
          previewWidth: 16,
          previewHeight: 16
        },
        maskMethod: "full-frame-fallback",
        maskAnalysis: {
          coverage: 1,
          confidence: 0,
          centralSupport: true,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          fallbackReason: "Synthetic smoke fixture uses a full-frame mask."
        },
        recipe: {
          lowFrequencySigma: 4.5,
          strongEdges: { low: 96, high: 192 },
          detailEdges: { low: 28, high: 84 },
          minContourAreaRatio: 0.0005,
          simplifyEpsilonRatio: 0.0015,
          maxPaths: 2000,
          maxVertices: 30000
        },
        channels: channelDefinitions.map(([id, family, encoding]) => ({
          id,
          family,
          path: pngPath,
          previewPath: pngPath,
          format: "png",
          width: 16,
          height: 16,
          previewWidth: 16,
          previewHeight: 16,
          encoding
        })),
        regionContours: [],
        openStrokes: [],
        complexity: {
          pathCount: 0,
          vertexCount: 0,
          edgeDensity: 0,
          saliency: {
            method: "gradient-magnitude",
            centroid: { x: 0.5, y: 0.5 },
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            covariance: { xx: 0, xy: 0, yy: 0 },
            mass: 0
          },
          budgets: { maxPaths: 2000, maxVertices: 30000 },
          warnings: []
        }
      }, null, 2)}\n`);
      const preview = await client.callTool({
        name: "prepare_ink_reveal_preview",
        arguments: {
          shotId: "bundled-publication-smoke",
          attentionTarget: "the center",
          duration: 10,
          visionAssetManifestPath: manifestPath,
          outputDirectory: resolve(root, "previews")
        }
      });
      if (preview.isError) throw new Error("bundled preview fixture failed");
      const published = await client.callTool({
        name: "publish_shot",
        arguments: {
          shotProgramPath: preview.structuredContent.result.shotProgramPath,
          previewIndexPath: preview.structuredContent.result.indexPath,
          deliveryProfile: {
            id: "smoke-16",
            width: 16,
            height: 16,
            fps: 1,
            codec: "h264",
            pixelFormat: "yuv420p"
          },
          outputRoot: resolve(root, "deliveries")
        }
      });
      if (published.isError || published.structuredContent.result.status !== "published") {
        throw new Error("bundled MCP did not publish the synthetic fixture");
      }
      await access(published.structuredContent.result.mp4Path);
      console.log("PASS: bundled MCP published an exact-frame fixture");

      if (opencvReady) {
        const directed = await client.callTool({
          name: "compile_director_project",
          arguments: {
            draftPath: resolve(pluginRoot, "examples/director/the-signal/director-draft.json"),
            outputRoot: resolve(root, "director")
          }
        });
        if (directed.isError) throw new Error("bundled Director fixture failed");
        const project = JSON.parse(await readFile(directed.structuredContent.result.projectPath, "utf8"));
        const shots = [];
        for (const shot of project.shots) {
          const selection = project.selections.find((entry) => entry.shotId === shot.id);
          const plan = project.shotProgramPlans.find((entry) => entry.shotId === shot.id);
          const vision = await client.callTool({
            name: "compile_vision_asset",
            arguments: {
              selectedImage: selection.selectedImage,
              recipe: plan.visionRecipe,
              artifactRoot: resolve(root, "story-vision", shot.id)
            }
          });
          if (vision.isError) throw new Error(`bundled Vision fixture failed for ${shot.id}`);
          const comparison = await client.callTool({
            name: "prepare_treatment_comparison",
            arguments: {
              shotId: shot.id,
              attentionTarget: shot.attentionTarget,
              duration: shot.duration,
              seed: plan.seed,
              directionHash: plan.directionHash,
              transitionOut: shot.transitionOut,
              visionAssetManifestPath: vision.structuredContent.result.manifestPath,
              outputDirectory: resolve(root, "story-previews", shot.id)
            }
          });
          if (comparison.isError) throw new Error(`bundled Treatment fixture failed for ${shot.id}`);
          let selectedProgramPath;
          for (const candidatePath of comparison.structuredContent.result.candidateProgramPaths) {
            const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
            if (candidate.treatment.id === shot.treatmentId) selectedProgramPath = candidatePath;
          }
          if (!selectedProgramPath) throw new Error(`missing directed Treatment for ${shot.id}`);
          shots.push({
            shotId: shot.id,
            shotProgramPath: selectedProgramPath,
            previewIndexPath: resolve(selectedProgramPath, "../index.html")
          });
        }
        const story = await client.callTool({
          name: "publish_story",
          arguments: {
            directorProjectPath: directed.structuredContent.result.projectPath,
            shots,
            deliveryProfile: {
              id: "bundled-story-smoke",
              width: 16,
              height: 16,
              fps: 1,
              codec: "h264",
              pixelFormat: "yuv420p"
            },
            outputRoot: resolve(root, "story-deliveries")
          }
        });
        if (story.isError || story.structuredContent.result.expectedFrameCount !== 20) {
          throw new Error("bundled MCP did not publish the directed multi-Shot fixture");
        }
        await access(story.structuredContent.result.mp4Path);
        console.log("PASS: bundled MCP published a directed multi-Shot Story");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
} finally {
  await client.close();
}
import { createHash } from "node:crypto";
