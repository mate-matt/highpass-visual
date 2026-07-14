import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  TransitionAssetManifestSchema,
  compileTransitionAsset
} from "../src/transition-compiler.js";
import { createTreatmentShotProgram } from "../src/shot-sampler.js";
import { createTransitionProgram, sampleTransitionProgram } from "../src/transition-program.js";
import { prepareTreatmentComparison } from "../src/preview-builder.js";
import { prepareTransitionProgram } from "../src/transition-preview-builder.js";
import { DEFAULT_VISION_RECIPE, compileVisionAsset } from "../src/vision-compiler.js";

function structuredPpm(shiftX = 0, shiftY = 0, seed = 0, width = 256, height = 192) {
  const pixels = Buffer.alloc(width * height * 3, 226);
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const px = x + shiftX;
    const py = y + shiftY;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
  };
  for (let y = 18; y < height - 18; y += 1) {
    for (let x = 24; x < width - 24; x += 1) {
      const ellipse = ((x - 128) / 78) ** 2 + ((y - 96) / 64) ** 2 < 1;
      if (!ellipse) continue;
      const checker = ((Math.floor(x / 11) + Math.floor(y / 13) + seed) % 2) === 0;
      paint(x, y, checker ? 31 : 88, checker ? 48 : 111, checker ? 77 : 146);
    }
  }
  for (let index = 0; index < 36; index += 1) {
    const x = 31 + ((index * 47 + seed * 19) % 190);
    const y = 24 + ((index * 61 + seed * 23) % 140);
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      if (dx * dx + dy * dy <= 9) paint(x + dx, y + dy, 220, 74 + index % 90, 35);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

function unrelatedPpm(width = 256, height = 192) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    pixels[offset] = (x * 71 + y * 13 + (x * y) % 251) % 256;
    pixels[offset + 1] = (x * 17 + y * 89 + (x + y) * 7) % 256;
    pixels[offset + 2] = (x * 43 + y * 37 + (x * y) * 3) % 256;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("Transition Compiler", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-transition-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function vision(id: string, bytes: Buffer) {
    const sourcePath = path.join(root, `${id}.ppm`);
    await writeFile(sourcePath, bytes);
    return compileVisionAsset({
      selectedImage: { id, path: sourcePath, contentHash: createHash("sha256").update(bytes).digest("hex") },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "vision")
    });
  }

  test("selects confidence-aware optical flow for a related translated pair and reuses the cache", async () => {
    const outgoing = await vision("outgoing", structuredPpm());
    const incoming = await vision("incoming", structuredPpm(4, 3));
    const request = {
      outgoingVisionManifestPath: outgoing.manifestPath,
      incomingVisionManifestPath: incoming.manifestPath,
      transitionIntent: { intent: "continuity" as const, duration: 1, reason: "Carry the same composition through a restrained move." },
      artifactRoot: path.join(root, "transitions")
    };
    const first = await compileTransitionAsset(request);
    const manifest = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(first.manifestPath, "utf8")));
    const second = await compileTransitionAsset(request);

    expect(first.cache).toBe("miss");
    expect(second).toMatchObject({ cache: "hit", artifactHash: first.artifactHash, manifestPath: first.manifestPath });
    expect(manifest.plan.selectedMethod).toBe("optical-flow-dissolve");
    expect(manifest.metrics.opticalFlow).toMatchObject({ passed: true, confidence: expect.any(Number), occlusionRatio: expect.any(Number) });
    expect(manifest.metrics.homography.filteredMatches).toBeGreaterThanOrEqual(20);
    expect(manifest.artifacts.flowForwardPath).toMatch(/flow-forward\.png$/);
    expect(manifest.artifacts.confidenceForwardPath).toMatch(/flow-confidence-forward\.png$/);
    expect(manifest.artifacts.confidenceBackwardPath).toMatch(/flow-confidence-backward\.png$/);
    expect(manifest.artifacts.occlusionForwardPath).toMatch(/flow-occlusion-forward\.png$/);
    expect(manifest.artifacts.occlusionBackwardPath).toMatch(/flow-occlusion-backward\.png$/);
    for (const [filePath, expectedHash] of [
      [manifest.artifacts.flowForwardPath, manifest.artifacts.flowForwardHash],
      [manifest.artifacts.flowBackwardPath, manifest.artifacts.flowBackwardHash],
      [manifest.artifacts.confidenceForwardPath, manifest.artifacts.confidenceForwardHash],
      [manifest.artifacts.confidenceBackwardPath, manifest.artifacts.confidenceBackwardHash],
      [manifest.artifacts.occlusionForwardPath, manifest.artifacts.occlusionForwardHash],
      [manifest.artifacts.occlusionBackwardPath, manifest.artifacts.occlusionBackwardHash]
    ] as const) expect(createHash("sha256").update(await readFile(filePath)).digest("hex")).toBe(expectedHash);

    const transitionIntent = request.transitionIntent;
    const outgoingProgram = createTreatmentShotProgram({
      shotId: "outgoing-shot", attentionTarget: "the repeated structure", duration: 8, seed: "outgoing-seed",
      transitionOut: transitionIntent, treatmentId: "memory-focus", selectedImageId: "outgoing",
      selectedImageHash: (await readFile(outgoing.manifestPath, "utf8").then((value) => JSON.parse(value))).provenance.sourceHash,
      visionAssetHash: outgoing.artifactHash, visionAssetManifestPath: outgoing.manifestPath
    });
    const incomingProgram = createTreatmentShotProgram({
      shotId: "incoming-shot", attentionTarget: "the translated structure", duration: 8, seed: "incoming-seed",
      transitionOut: { intent: "terminal", duration: 0, lockedMethod: "cut", reason: "The incoming Shot is the final held image." },
      treatmentId: "memory-focus", selectedImageId: "incoming",
      selectedImageHash: (await readFile(incoming.manifestPath, "utf8").then((value) => JSON.parse(value))).provenance.sourceHash,
      visionAssetHash: incoming.artifactHash, visionAssetManifestPath: incoming.manifestPath
    });
    const program = createTransitionProgram({
      outgoingProgram,
      outgoingProgramPath: "/story/outgoing/shot-program.json",
      incomingProgram,
      incomingProgramPath: "/story/incoming/shot-program.json",
      transitionAsset: manifest,
      transitionAssetManifestPath: first.manifestPath
    });
    expect(program.duration).toBe(1);
    expect(sampleTransitionProgram(program, 0)).toMatchObject({ outgoingSceneTime: 7, incomingSceneTime: 0, blend: 0 });
    expect(sampleTransitionProgram(program, 0.5)).toMatchObject({ outgoingSceneTime: 7.5, incomingSceneTime: 0.5 });
    expect(sampleTransitionProgram(program, 1)).toMatchObject({ outgoingSceneTime: 8, incomingSceneTime: 1, blend: 1 });
    const reduced = sampleTransitionProgram(program, 0.5, { reducedMotion: true });
    expect(reduced).toMatchObject({ blend: 0.5, spatialWarp: 0 });

    const outgoingComparison = await prepareTreatmentComparison({
      shotId: "outgoing-shot", attentionTarget: "the repeated structure", duration: 8, seed: "outgoing-seed",
      transitionOut: transitionIntent, visionAssetManifestPath: outgoing.manifestPath, outputDirectory: path.join(root, "outgoing-previews")
    });
    const incomingComparison = await prepareTreatmentComparison({
      shotId: "incoming-shot", attentionTarget: "the translated structure", duration: 8, seed: "incoming-seed",
      transitionOut: { intent: "terminal", duration: 0, lockedMethod: "cut", reason: "The incoming Shot is the final held image." },
      visionAssetManifestPath: incoming.manifestPath, outputDirectory: path.join(root, "incoming-previews")
    });
    const prepared = await prepareTransitionProgram({
      outgoingShotProgramPath: outgoingComparison.candidateProgramPaths[1],
      outgoingPreviewIndexPath: path.join(path.dirname(outgoingComparison.candidateProgramPaths[1]), "index.html"),
      incomingShotProgramPath: incomingComparison.candidateProgramPaths[1],
      incomingPreviewIndexPath: path.join(path.dirname(incomingComparison.candidateProgramPaths[1]), "index.html"),
      transitionAssetManifestPath: first.manifestPath,
      outputDirectory: path.join(root, "transition-previews")
    });
    expect(prepared.selectedMethod).toBe("optical-flow-dissolve");
    const previewHtml = await readFile(prepared.indexPath, "utf8");
    expect(previewHtml).toContain("function flow(");
    expect(previewHtml).toContain("function homography(");
    expect(previewHtml).toContain("function distance(");
    expect(previewHtml).toContain("function contours(");
    await writeFile(prepared.indexPath, "tampered transition renderer");
    const repairedPreview = await prepareTransitionProgram({
      outgoingShotProgramPath: outgoingComparison.candidateProgramPaths[1],
      outgoingPreviewIndexPath: path.join(path.dirname(outgoingComparison.candidateProgramPaths[1]), "index.html"),
      incomingShotProgramPath: incomingComparison.candidateProgramPaths[1],
      incomingPreviewIndexPath: path.join(path.dirname(incomingComparison.candidateProgramPaths[1]), "index.html"),
      transitionAssetManifestPath: first.manifestPath,
      outputDirectory: path.join(root, "transition-previews")
    });
    expect(createHash("sha256").update(await readFile(repairedPreview.indexPath)).digest("hex")).toBe(repairedPreview.htmlHash);
    const outgoingIndex = path.join(path.dirname(outgoingComparison.candidateProgramPaths[1]), "index.html");
    await writeFile(outgoingIndex, `${await readFile(outgoingIndex, "utf8")}<!-- substituted -->`);
    await expect(prepareTransitionProgram({
      outgoingShotProgramPath: outgoingComparison.candidateProgramPaths[1],
      outgoingPreviewIndexPath: outgoingIndex,
      incomingShotProgramPath: incomingComparison.candidateProgramPaths[1],
      incomingPreviewIndexPath: path.join(path.dirname(incomingComparison.candidateProgramPaths[1]), "index.html"),
      transitionAssetManifestPath: first.manifestPath,
      outputDirectory: path.join(root, "transition-previews")
    })).rejects.toThrow(/content binding/i);
    const damaged = await readFile(manifest.artifacts.confidenceForwardPath);
    damaged[damaged.length - 1] ^= 1;
    await writeFile(manifest.artifacts.confidenceForwardPath, damaged);
    expect((await compileTransitionAsset(request)).cache).toBe("miss");
  }, 60_000);

  test("honors passing locked homography and contour methods", async () => {
    const outgoing = await vision("outgoing", structuredPpm());
    const incoming = await vision("incoming", structuredPpm(4, 3));
    const homography = await compileTransitionAsset({
      outgoingVisionManifestPath: outgoing.manifestPath,
      incomingVisionManifestPath: incoming.manifestPath,
      transitionIntent: { intent: "continuity", duration: 1, lockedMethod: "homography-dissolve", reason: "Align the repeated architecture before the blend." },
      artifactRoot: path.join(root, "transitions")
    });
    const homographyManifest = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(homography.manifestPath, "utf8")));
    expect(homographyManifest.plan.selectedMethod).toBe("homography-dissolve");
    expect(homographyManifest.metrics.homography.passed).toBe(true);
    expect(homographyManifest.artifacts.homography).toHaveLength(9);

    const contour = await compileTransitionAsset({
      outgoingVisionManifestPath: outgoing.manifestPath,
      incomingVisionManifestPath: incoming.manifestPath,
      transitionIntent: { intent: "reveal", duration: 1, lockedMethod: "contour-morph", reason: "Let the shared silhouette grow into its next position." },
      artifactRoot: path.join(root, "transitions")
    });
    const contourManifest = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(contour.manifestPath, "utf8")));
    expect(contourManifest.plan.selectedMethod).toBe("contour-morph");
    expect(contourManifest.metrics.contours.passed).toBe(true);
    expect(contourManifest.contourCorrespondences[0].outgoing).toHaveLength(64);
    expect(contourManifest.contourCorrespondences[0].incoming).toHaveLength(64);
    for (const pair of contourManifest.contourCorrespondences) {
      const area = (points: Array<{ x: number; y: number }>) => points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point.x * next.y - next.x * point.y;
      }, 0) / 2;
      expect(area(pair.outgoing) * area(pair.incoming)).toBeGreaterThanOrEqual(0);
      const cost = (shift: number) => pair.outgoing.reduce((sum, point, index) => {
        const other = pair.incoming[(index + shift) % pair.incoming.length];
        return sum + (point.x - other.x) ** 2 + (point.y - other.y) ** 2;
      }, 0);
      expect(cost(0)).toBeLessThanOrEqual(Math.min(...pair.incoming.map((_, index) => cost(index))) + 1e-9);
    }
  }, 60_000);

  test("falls back for an unrelated pair and rejects a failing locked method", async () => {
    const outgoing = await vision("outgoing", structuredPpm());
    const unrelated = await vision("unrelated", unrelatedPpm());
    const request = {
      outgoingVisionManifestPath: outgoing.manifestPath,
      incomingVisionManifestPath: unrelated.manifestPath,
      transitionIntent: { intent: "continuity" as const, duration: 1, reason: "Try continuity but preserve a safe deterministic fallback." },
      artifactRoot: path.join(root, "transitions")
    };
    const result = await compileTransitionAsset(request);
    const manifest = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    expect(manifest.plan.selectedMethod).toBe("cross-dissolve");
    expect(manifest.plan.rejectedMethods).toContain("optical-flow-dissolve");
    expect(manifest.plan.selectionReason).toMatch(/fallback|quality/i);

    await expect(compileTransitionAsset({
      ...request,
      transitionIntent: { ...request.transitionIntent, lockedMethod: "optical-flow-dissolve" as const }
    })).rejects.toMatchObject({ code: "LOCKED_TRANSITION_QUALITY_GATE_FAILED" });
  }, 60_000);
});
