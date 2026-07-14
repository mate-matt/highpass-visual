import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { prepareInkRevealPreview } from "../src/preview-builder.js";
import {
  PUBLICATION_GENERATOR_VERSION,
  QualityEvidenceSchema,
  PublicationError,
  publishShot,
  verifyDelivery
} from "../src/publication-pipeline.js";
import { DEFAULT_BROWSER_COMMANDS, createSystemCommandProbe, resolveLocalExecutable, type CommandProbe } from "../src/runtime-inspection.js";
import { DEFAULT_VISION_RECIPE, compileVisionAsset } from "../src/vision-compiler.js";

const browserPath = DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));

function publicationFixture(width = 32, height = 24) {
  const pixels = Buffer.alloc(width * height * 3, 235);
  for (let y = 4; y < 21; y += 1) {
    for (let x = 5; x < 27; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 27 + ((x + y) % 5) * 12;
      pixels[offset + 1] = 58;
      pixels[offset + 2] = 103;
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("Publication Pipeline", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-publication-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("publishes exactly 300 deterministic frames, resumes them, and rejects a corrupted delivery", async () => {
    expect(browserPath, "A supported Chromium browser is required for publication validation.").toBeDefined();
    const sourcePath = path.join(root, "selected.ppm");
    const sourceBytes = publicationFixture();
    await writeFile(sourcePath, sourceBytes);
    const vision = await compileVisionAsset({
      selectedImage: { id: "publish-selected", path: sourcePath, contentHash: createHash("sha256").update(sourceBytes).digest("hex") },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "vision")
    });
    const preview = await prepareInkRevealPreview({
      shotId: "publish-shot",
      attentionTarget: "the center window",
      duration: 10,
      visionAssetManifestPath: vision.manifestPath,
      outputDirectory: path.join(root, "previews")
    });
    const request = {
      shotProgramPath: preview.shotProgramPath,
      previewIndexPath: preview.indexPath,
      deliveryProfile: {
        id: "test-landscape",
        width: 64,
        height: 48,
        fps: 30,
        codec: "h264" as const,
        pixelFormat: "yuv420p" as const
      },
      outputRoot: path.join(root, "deliveries")
    };
    const options = { browserExecutable: browserPath! };

    const first = await publishShot(request, options);
    const evidence = QualityEvidenceSchema.parse(JSON.parse(await readFile(first.qualityEvidencePath, "utf8")));
    expect(first.status).toBe("published");
    if (evidence.status !== "published" || !first.mp4Path) throw new Error("expected published fixture");
    expect(first).toMatchObject({ expectedFrameCount: 300, renderedFrames: 300, reusedFrames: 0 });
    expect(evidence.media).toMatchObject({
      frameCount: 300,
      width: 64,
      height: 48,
      codec: "h264",
      pixelFormat: "yuv420p"
    });
    expect(evidence.media.frameRate).toBe("30/1");
    expect(evidence.media.duration).toBeCloseTo(10, 3);
    expect(evidence.selectedFrames.map(({ index }) => index)).toEqual([0, 150, 299]);
    expect(new Set(evidence.selectedFrames.map(({ pngHash }) => pngHash)).size).toBe(3);

    const fresh = await publishShot({ ...request, outputRoot: path.join(root, "fresh-deliveries") }, options);
    const freshEvidence = QualityEvidenceSchema.parse(JSON.parse(await readFile(fresh.qualityEvidencePath, "utf8")));
    expect(fresh).toMatchObject({ status: "published", renderedFrames: 300, reusedFrames: 0 });
    expect(freshEvidence.selectedFrames).toEqual(evidence.selectedFrames);

    const second = await publishShot(request, options);
    expect(second).toMatchObject({ expectedFrameCount: 300, renderedFrames: 0, reusedFrames: 300 });
    const secondEvidence = QualityEvidenceSchema.parse(JSON.parse(await readFile(second.qualityEvidencePath, "utf8")));
    expect(secondEvidence.selectedFrames).toEqual(evidence.selectedFrames);

    const staleRecordPath = path.join(path.dirname(first.frameManifestPath), "frame-records", "frame-000137.json");
    const staleRecord = JSON.parse(await readFile(staleRecordPath, "utf8"));
    staleRecord.requestedSceneTime = 999;
    await writeFile(staleRecordPath, JSON.stringify(staleRecord));
    const staleRecordRepair = await publishShot(request, options);
    expect(staleRecordRepair).toMatchObject({ renderedFrames: 1, reusedFrames: 299 });

    const frameManifest = JSON.parse(await readFile(first.frameManifestPath, "utf8")) as {
      frames: Array<{ path: string }>;
    };
    await writeFile(frameManifest.frames[137].path, "corrupted");
    const repaired = await publishShot(request, options);
    expect(repaired).toMatchObject({ renderedFrames: 1, reusedFrames: 299 });

    const repairedEvidenceText = await readFile(repaired.qualityEvidencePath, "utf8");
    const repairedEvidence = QualityEvidenceSchema.parse(JSON.parse(repairedEvidenceText));
    if (repairedEvidence.status !== "published") throw new Error("expected repaired publication");
    await writeFile(repaired.qualityEvidencePath, JSON.stringify({
      ...repairedEvidence,
      media: { ...repairedEvidence.media, frameCount: repairedEvidence.media.frameCount - 1 }
    }));
    await expect(verifyDelivery(repaired.qualityEvidencePath)).rejects.toMatchObject({ code: "QUALITY_EVIDENCE_MISMATCH" });
    await writeFile(repaired.qualityEvidencePath, repairedEvidenceText);

    const frameManifestText = await readFile(repaired.frameManifestPath, "utf8");
    const incompleteManifest = JSON.parse(frameManifestText) as { frames: Array<unknown> };
    incompleteManifest.frames[42] = incompleteManifest.frames[41];
    await writeFile(repaired.frameManifestPath, JSON.stringify(incompleteManifest));
    await expect(verifyDelivery(repaired.qualityEvidencePath)).rejects.toMatchObject({ code: "INCOMPLETE_FRAME_MANIFEST" });
    await writeFile(repaired.frameManifestPath, frameManifestText);

    const smallRequest = {
      ...request,
      deliveryProfile: { ...request.deliveryProfile, id: "small-generator", fps: 1 },
      outputRoot: path.join(root, "small-deliveries")
    };
    const generatorA = await publishShot(smallRequest, { ...options, generatorVersion: PUBLICATION_GENERATOR_VERSION });
    const generatorB = await publishShot(smallRequest, { ...options, generatorVersion: "0.1.1-test" });
    expect(generatorA).toMatchObject({ renderedFrames: 10, reusedFrames: 0 });
    expect(generatorB).toMatchObject({ renderedFrames: 10, reusedFrames: 0 });
    expect(generatorB.deliveryHash).not.toBe(generatorA.deliveryHash);

    const concurrentRequest = { ...smallRequest, outputRoot: path.join(root, "concurrent-deliveries") };
    const concurrent = await Promise.all([
      publishShot(concurrentRequest, { ...options, generatorVersion: "concurrent-test" }),
      publishShot(concurrentRequest, { ...options, generatorVersion: "concurrent-test" })
    ]);
    expect(concurrent.every(({ status }) => status === "published")).toBe(true);
    expect(concurrent.map(({ renderedFrames }) => renderedFrames).sort((a, b) => a - b)).toEqual([0, 10]);

    const systemProbe = createSystemCommandProbe({ timeoutMs: 180_000, maxOutputBytes: 65_536 });
    const failingEncodeProbe: CommandProbe = {
      run(command, args, probeOptions) {
        if (command === "ffmpeg" && args?.[0] === "-loglevel") {
          return Promise.resolve({ ok: false, stdout: "", stderr: "encoder unavailable" });
        }
        return systemProbe.run(command, args, probeOptions);
      }
    };
    const fallback = await publishShot(
      { ...smallRequest, outputRoot: path.join(root, "fallback-deliveries") },
      { ...options, commandProbe: failingEncodeProbe, generatorVersion: "fallback-test" }
    );
    expect(fallback).toMatchObject({ status: "lossless-fallback", mp4Path: null, renderedFrames: 10 });
    const fallbackEvidence = await verifyDelivery(fallback.qualityEvidencePath);
    expect(fallbackEvidence.status).toBe("lossless-fallback");

    if (!repaired.mp4Path) throw new Error("expected repaired MP4");
    const alternateMp4 = path.join(root, "alternate.mp4");
    const alternate = await systemProbe.run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi",
      "-i", "color=c=red:s=64x48:r=30:d=10",
      "-frames:v", "300",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      alternateMp4
    ]);
    expect(alternate.ok).toBe(true);
    await copyFile(alternateMp4, repaired.mp4Path);
    await expect(verifyDelivery(repaired.qualityEvidencePath)).rejects.toBeInstanceOf(PublicationError);
  }, 120_000);
});
import { createHash } from "node:crypto";
