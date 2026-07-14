import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { prepareTreatmentComparison } from "../src/preview-builder.js";
import {
  TREATMENT_CONTROL_DEFINITIONS,
  assertComparableTreatments,
  createTreatmentShotProgram,
  sampleShotProgram
} from "../src/shot-sampler.js";
import { DEFAULT_VISION_RECIPE, VisionAssetManifestSchema, compileVisionAsset } from "../src/vision-compiler.js";

function fixture(width = 32, height = 24) {
  const pixels = Buffer.alloc(width * height * 3, 225);
  for (let y = 4; y < 20; y += 1) for (let x = 6; x < 27; x += 1) {
    const offset = (y * width + x) * 3;
    pixels[offset] = 25 + x * 3;
    pixels[offset + 1] = 55 + y * 2;
    pixels[offset + 2] = 112;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("data-driven Treatments", () => {
  let root: string;
  let manifestPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-treatments-test-"));
    const sourcePath = path.join(root, "selected.ppm");
    const sourceBytes = fixture();
    await writeFile(sourcePath, sourceBytes);
    manifestPath = (await compileVisionAsset({
      selectedImage: { id: "treatment-image", path: sourcePath, contentHash: createHash("sha256").update(sourceBytes).digest("hex") },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "vision")
    })).manifestPath;
  }, 60_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  test("declares bounded meaningful controls and compiles signed detail channels", async () => {
    for (const treatment of Object.values(TREATMENT_CONTROL_DEFINITIONS)) {
      for (const control of Object.values(treatment.controls)) {
        expect(control.meaning.length).toBeGreaterThan(8);
        expect(Number.isFinite(control.min)).toBe(true);
        expect(Number.isFinite(control.max)).toBe(true);
        expect(control.min).toBeLessThan(control.max);
        expect(control.default).toBeGreaterThanOrEqual(control.min);
        expect(control.default).toBeLessThanOrEqual(control.max);
        expect(control.affectedChannels.length).toBeGreaterThan(0);
      }
    }
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    expect(manifest.channels.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "signed-detail-light",
      "signed-detail-dark"
    ]));
  });

  test("keeps narrative identity stable while all treatments use one sampler", async () => {
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const common = {
      shotId: "same-story-shot",
      attentionTarget: "the lit doorway",
      duration: 10,
      seed: "comparison-seed",
      selectedImageId: manifest.source.selectedImageId,
      selectedImageHash: manifest.provenance.sourceHash,
      visionAssetHash: manifest.artifactHash,
      visionAssetManifestPath: manifestPath
    };
    const programs = (["ink-reveal", "memory-focus", "etched-light"] as const)
      .map((treatmentId) => createTreatmentShotProgram({ ...common, treatmentId }));
    expect(new Set(programs.map(({ shot }) => shot.narrativeIdentityHash)).size).toBe(1);
    expect(new Set(programs.map(({ programHash }) => programHash)).size).toBe(3);
    expect(() => assertComparableTreatments(programs)).not.toThrow();
    for (const program of programs) {
      expect(sampleShotProgram(program, 4.25)).toMatchObject({ sceneTime: 4.25, programHash: program.programHash });
    }
    expect(() => createTreatmentShotProgram({
      ...common,
      treatmentId: "ink-reveal",
      controls: { lineWidth: 99 }
    })).toThrow();
    expect(() => createTreatmentShotProgram({
      ...common,
      treatmentId: "ink-reveal",
      controls: { lineWidht: 1.2 }
    })).toThrow();
    expect(() => createTreatmentShotProgram({ ...common, treatmentId: "unknown" as "ink-reveal" })).toThrow();
    const changedNarrative = createTreatmentShotProgram({ ...common, attentionTarget: "a different subject", treatmentId: "etched-light" });
    expect(() => assertComparableTreatments([programs[0], changedNarrative])).toThrow();
  });

  test("stages Memory Focus continuously and keeps Etched Light texture subordinate", async () => {
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const common = {
      shotId: "treatment-rules",
      attentionTarget: "the arch",
      duration: 10,
      seed: "rules-seed",
      selectedImageId: manifest.source.selectedImageId,
      selectedImageHash: manifest.provenance.sourceHash,
      visionAssetHash: manifest.artifactHash,
      visionAssetManifestPath: manifestPath
    };
    const memory = createTreatmentShotProgram({ ...common, treatmentId: "memory-focus" });
    const blur = Array.from({ length: 101 }, (_, index) => sampleShotProgram(memory, index / 10).layers.blurPx);
    expect(Math.max(...blur.slice(1).map((value, index) => Math.abs(value - blur[index])))).toBeLessThan(1.5);
    expect(sampleShotProgram(memory, 1).layers.lowFrequencyOpacity).toBeGreaterThan(0.4);
    expect(sampleShotProgram(memory, 4).layers.strongEdgeProgress).toBeGreaterThan(0.3);
    expect(sampleShotProgram(memory, 7).layers.detailEdgeProgress).toBeGreaterThan(0.2);

    const etched = createTreatmentShotProgram({ ...common, treatmentId: "etched-light" });
    expect(etched.treatment.render.signedLightGain).toBeGreaterThan(0);
    expect(etched.treatment.render.signedDarkGain).toBeGreaterThan(0);
    expect(etched.treatment.render.detailEdgeGain).toBeLessThanOrEqual(etched.treatment.render.strongEdgeGain * 0.5);
    const etchedAtCeiling = createTreatmentShotProgram({ ...common, treatmentId: "etched-light", controls: { textureCeiling: 0.17 } });
    expect(etchedAtCeiling.treatment.render.detailEdgeGain).toBeLessThanOrEqual(etchedAtCeiling.treatment.render.strongEdgeGain * 0.5);
    expect(() => createTreatmentShotProgram({ ...common, treatmentId: "etched-light", controls: { textureCeiling: 0.171 } })).toThrow();
  });

  test("builds an identical-condition comparison and rejects missing required channels", async () => {
    const comparison = await prepareTreatmentComparison({
      shotId: "compare-shot",
      attentionTarget: "the central figure",
      duration: 6,
      seed: "locked-seed",
      visionAssetManifestPath: manifestPath,
      outputDirectory: path.join(root, "comparison")
    });
    const manifest = JSON.parse(await readFile(comparison.comparisonManifestPath, "utf8"));
    expect(manifest.candidates).toHaveLength(3);
    expect(new Set(manifest.candidates.map((candidate: { narrativeIdentityHash: string }) => candidate.narrativeIdentityHash)).size).toBe(1);
    expect(new Set(manifest.candidates.map((candidate: { duration: number }) => candidate.duration))).toEqual(new Set([6]));
    expect(new Set(manifest.candidates.map((candidate: { seed: string }) => candidate.seed))).toEqual(new Set(["locked-seed"]));
    expect(new Set(manifest.candidates.map((candidate: { renderSize: string }) => JSON.stringify(candidate.renderSize))).size).toBe(1);
    expect(manifest.probeTimes).toEqual([0, 1.5, 3, 4.5, 5.999]);

    const vision = JSON.parse(await readFile(manifestPath, "utf8"));
    const lightIndex = vision.channels.findIndex(({ id }: { id: string }) => id === "signed-detail-light");
    vision.channels[lightIndex] = { ...vision.channels.find(({ id }: { id: string }) => id === "signed-detail-dark") };
    const brokenPath = path.join(root, "broken-manifest.json");
    await writeFile(brokenPath, JSON.stringify(vision));
    await expect(prepareTreatmentComparison({
      shotId: "broken",
      attentionTarget: "the center",
      duration: 10,
      seed: "locked-seed",
      visionAssetManifestPath: brokenPath,
      outputDirectory: path.join(root, "broken")
    })).rejects.toThrow(/requires missing Vision Asset channels: signed-detail-light/);
  });
});
import { createHash } from "node:crypto";
