import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_VISION_RECIPE,
  VisionAssetManifestSchema,
  compileVisionAsset
} from "../src/vision-compiler.js";

function fixturePpm(width = 96, height = 72) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3, 244);
  for (let y = 8; y < height - 8; y += 1) {
    for (let x = 10; x < width - 10; x += 1) {
      const dx = (x - width / 2) / (width * 0.32);
      const dy = (y - height / 2) / (height * 0.35);
      if (dx * dx + dy * dy < 1) {
        const value = (x + y) % 11 < 3 ? 32 : 82;
        const offset = (y * width + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = Math.min(255, value + 24);
        pixels[offset + 2] = Math.min(255, value + 52);
      }
    }
  }
  for (let y = 30; y < 42; y += 1) {
    for (let x = 42; x < 54; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 244;
      pixels[offset + 1] = 244;
      pixels[offset + 2] = 244;
    }
  }
  return Buffer.concat([header, pixels]);
}

function architecturalPpm(width = 96, height = 72) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3, 236);
  for (let y = 8; y < height - 6; y += 1) {
    for (let x = 8; x < width - 8; x += 1) {
      const structural = x % 16 < 3 || y % 18 < 3 || (x > 34 && x < 62 && y > 26 && y < 60);
      if (!structural) continue;
      const offset = (y * width + x) * 3;
      pixels[offset] = 28;
      pixels[offset + 1] = 44;
      pixels[offset + 2] = 70;
    }
  }
  return Buffer.concat([header, pixels]);
}

function texturedPpm(width = 96, height = 72) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (x * 37 + y * 61 + ((x * y) % 29) * 7) % 256;
      const offset = (y * width + x) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = (value * 3 + 41) % 256;
      pixels[offset + 2] = (value * 5 + 83) % 256;
    }
  }
  return Buffer.concat([header, pixels]);
}

describe("Vision Compiler", () => {
  let root: string;
  let sourcePath: string;
  let sourceHash: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-vision-test-"));
    sourcePath = path.join(root, "selected.ppm");
    const bytes = fixturePpm();
    sourceHash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(sourcePath, bytes);
  }, 60_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  test("compiles required raster families and normalized path geometry, then reuses the cache", async () => {
    const request = {
      selectedImage: { id: "selected-01", path: sourcePath, contentHash: sourceHash },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "artifacts")
    };

    const first = await compileVisionAsset(request);
    const firstBytes = await readFile(first.manifestPath, "utf8");
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(firstBytes));
    const second = await compileVisionAsset(request);

    expect(first.cache).toBe("miss");
    expect(second).toMatchObject({
      cache: "hit",
      artifactHash: first.artifactHash,
      manifestPath: first.manifestPath
    });
    expect(await readFile(second.manifestPath, "utf8")).toBe(firstBytes);
    expect(manifest.schemaVersion).toBe("highpass.vision-asset.v1");
    expect(manifest.provenance).toMatchObject({
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      parameterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      generatorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      dependencyHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(new Set(manifest.channels.map(({ id }) => id))).toEqual(new Set([
      "low-frequency",
      "signed-detail",
      "signed-detail-light",
      "signed-detail-dark",
      "strong-edge",
      "detail-edge",
      "subject-mask",
      "distance-field",
      "foreground-plate",
      "middle-plate",
      "background-plate",
      "depth-proxy"
    ]));
    for (const channel of manifest.channels) {
      expect((await stat(channel.path)).size).toBeGreaterThan(0);
      expect((await stat(channel.previewPath)).size).toBeGreaterThan(0);
      expect(channel.previewWidth * channel.previewHeight).toBeLessThanOrEqual(1280 * 720);
    }
    expect(manifest.source.previewWidth * manifest.source.previewHeight).toBeLessThanOrEqual(1280 * 720);

    const contourIds = new Set(manifest.regionContours.map(({ id }) => id));
    expect(manifest.regionContours.length).toBeGreaterThan(0);
    expect(manifest.regionContours.some(({ hole, parentId }) => hole && parentId !== null)).toBe(true);
    for (const contour of manifest.regionContours) {
      expect(contour.parentId === null || contourIds.has(contour.parentId)).toBe(true);
      for (const point of contour.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }

    expect(manifest.openStrokes.length).toBeGreaterThan(0);
    for (const stroke of manifest.openStrokes) {
      expect(stroke.cumulativeLength).toHaveLength(stroke.points.length);
      expect(stroke.cumulativeLength[0]).toBe(0);
      expect(stroke.cumulativeLength.at(-1)).toBeCloseTo(stroke.length, 8);
      expect(stroke.points[0]).not.toEqual(stroke.points.at(-1));
      for (let index = 1; index < stroke.cumulativeLength.length; index += 1) {
        expect(stroke.cumulativeLength[index]).toBeGreaterThanOrEqual(stroke.cumulativeLength[index - 1]);
      }
    }
    expect(manifest.complexity.budgets).toEqual({
      maxPaths: DEFAULT_VISION_RECIPE.maxPaths,
      maxVertices: DEFAULT_VISION_RECIPE.maxVertices
    });
    expect(manifest.complexity.saliency).toMatchObject({
      method: "gradient-magnitude",
      centroid: { x: expect.any(Number), y: expect.any(Number) },
      bounds: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
      covariance: { xx: expect.any(Number), xy: expect.any(Number), yy: expect.any(Number) },
      mass: expect.any(Number)
    });
    expect(manifest.maskMethod).toBe("grabcut");
    expect(manifest.maskAnalysis).toMatchObject({
      coverage: expect.any(Number),
      confidence: expect.any(Number),
      centralSupport: true,
      bounds: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
      fallbackReason: null
    });
    expect(manifest.maskAnalysis.coverage).toBeGreaterThanOrEqual(0.03);
    expect(manifest.maskAnalysis.coverage).toBeLessThanOrEqual(0.9);
  }, 60_000);

  test("changes the content address when a recipe parameter changes", async () => {
    const artifactRoot = path.join(root, "artifacts");
    const first = await compileVisionAsset({
      selectedImage: { id: "selected-01", path: sourcePath, contentHash: sourceHash },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot
    });
    const second = await compileVisionAsset({
      selectedImage: { id: "selected-01", path: sourcePath, contentHash: sourceHash },
      recipe: { ...DEFAULT_VISION_RECIPE, lowFrequencySigma: 7 },
      artifactRoot
    });

    expect(second.artifactHash).not.toBe(first.artifactHash);
    expect(second.manifestPath).not.toBe(first.manifestPath);

    const differentIdentity = await compileVisionAsset({
      selectedImage: { id: "selected-02", path: sourcePath, contentHash: sourceHash },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot
    });
    expect(differentIdentity.artifactHash).not.toBe(first.artifactHash);
  }, 60_000);

  test("includes an explicit mask in the source address and rebuilds a damaged cache entry", async () => {
    const maskPath = path.join(root, "subject-mask.pgm");
    const maskPixels = Buffer.alloc(96 * 72, 0);
    maskPixels.fill(255, 18 * 96 + 20, 52 * 96 + 76);
    await writeFile(maskPath, Buffer.concat([Buffer.from("P5\n96 72\n255\n"), maskPixels]));
    const request = {
      selectedImage: { id: "selected-mask", path: sourcePath, contentHash: sourceHash, maskPath },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "mask-artifacts")
    };
    const first = await compileVisionAsset(request);
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(first.manifestPath, "utf8")));
    expect(manifest.source.maskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.maskMethod).toBe("explicit");
    expect(manifest.maskAnalysis.confidence).toBe(1);

    await rm(manifest.channels[0].path);
    const repaired = await compileVisionAsset(request);
    expect(repaired.cache).toBe("miss");
    expect((await stat(manifest.channels[0].path)).size).toBeGreaterThan(0);

    maskPixels[36 * 96 + 48] = 0;
    await writeFile(maskPath, Buffer.concat([Buffer.from("P5\n96 72\n255\n"), maskPixels]));
    const changedMask = await compileVisionAsset(request);
    expect(changedMask.artifactHash).not.toBe(first.artifactHash);
  }, 60_000);

  test("preserves soft explicit mattes and emits non-overlapping parallax plates", async () => {
    const maskPath = path.join(root, "soft-subject-mask.pgm");
    const maskPixels = Buffer.alloc(96 * 72, 0);
    for (let y = 16; y < 56; y += 1) for (let x = 18; x < 78; x += 1) {
      const edge = Math.min(x - 18, 77 - x, y - 16, 55 - y);
      maskPixels[y * 96 + x] = edge <= 1 ? 64 : edge <= 3 ? 160 : 255;
    }
    await writeFile(maskPath, Buffer.concat([Buffer.from("P5\n96 72\n255\n"), maskPixels]));
    const result = await compileVisionAsset({
      selectedImage: { id: "selected-soft-mask", path: sourcePath, contentHash: sourceHash, maskPath },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "soft-mask-artifacts")
    });
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    const channel = (id: string) => manifest.channels.find((entry) => entry.id === id)!.path;
    const script = [
      "import cv2,hashlib,json,sys,numpy as np",
      "mask=cv2.imread(sys.argv[1],cv2.IMREAD_GRAYSCALE)",
      "middle=cv2.imread(sys.argv[2],cv2.IMREAD_UNCHANGED)",
      "source=cv2.imread(sys.argv[3],cv2.IMREAD_COLOR)",
      "background=cv2.imread(sys.argv[4],cv2.IMREAD_COLOR)",
      "subject=mask>=128",
      "print(json.dumps({'maskHash':hashlib.sha256(mask.tobytes()).hexdigest(),'values':sorted(np.unique(mask).tolist()),'middleAlphaOnSubject':int(np.count_nonzero(middle[:,:,3][subject])),'middleAlphaOutside':int(np.count_nonzero(middle[:,:,3][~subject])),'backgroundDifference':int(np.count_nonzero(cv2.absdiff(source,background)[subject]))}))"
    ].join(";");
    const measured = JSON.parse(execFileSync(path.join(process.cwd(), ".venv", "bin", "python"), ["-c", script, channel("subject-mask"), channel("middle-plate"), manifest.source.compiledPath, channel("background-plate")], { encoding: "utf8" }));
    expect(measured.maskHash).toBe(createHash("sha256").update(maskPixels).digest("hex"));
    expect(measured.values).toEqual([0, 64, 160, 255]);
    expect(measured.middleAlphaOnSubject).toBe(0);
    expect(measured.middleAlphaOutside).toBeGreaterThan(0);
    expect(measured.backgroundDifference).toBeGreaterThan(0);
    expect(manifest.channels.find(({ id }) => id === "middle-plate")).toMatchObject({ family: "rgba-plate", encoding: "bgra8-context-ring-alpha" });
  }, 60_000);

  test("keeps architectural and high-texture fixtures inside declared budgets", async () => {
    for (const [name, bytes] of [
      ["architectural", architecturalPpm()],
      ["high-texture", texturedPpm()]
    ] as const) {
      const pathForFixture = path.join(root, `${name}.ppm`);
      await writeFile(pathForFixture, bytes);
      const warningRecipe = { ...DEFAULT_VISION_RECIPE, maxPaths: 5, maxVertices: 16 };
      const result = await compileVisionAsset({
        selectedImage: { id: `selected-${name}`, path: pathForFixture, contentHash: createHash("sha256").update(bytes).digest("hex") },
        recipe: warningRecipe,
        artifactRoot: path.join(root, "representative-artifacts")
      });
      const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
      expect(manifest.openStrokes.length).toBeGreaterThan(0);
      expect(manifest.complexity.edgeDensity).toBeGreaterThan(0);
      expect(
        manifest.complexity.pathCount > manifest.complexity.budgets.maxPaths
        || manifest.complexity.vertexCount > manifest.complexity.budgets.maxVertices
      ).toBe(true);
      expect(manifest.complexity.warnings.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("records a full-frame fallback when GrabCut and morphology have no subject evidence", async () => {
    const width = 64;
    const height = 48;
    const flat = Buffer.concat([
      Buffer.from(`P6\n${width} ${height}\n255\n`),
      Buffer.alloc(width * height * 3, 128)
    ]);
    const flatPath = path.join(root, "flat.ppm");
    await writeFile(flatPath, flat);
    const compiled = await compileVisionAsset({
      selectedImage: { id: "selected-flat", path: flatPath, contentHash: createHash("sha256").update(flat).digest("hex") },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "flat-artifacts")
    });
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(compiled.manifestPath, "utf8")));
    expect(manifest.maskMethod).toBe("full-frame-fallback");
    expect(manifest.maskAnalysis).toMatchObject({
      coverage: 1,
      confidence: 0.15,
      fallbackReason: "grabcut-and-otsu-degenerate"
    });
  }, 60_000);

  test("commits one valid artifact when identical compilations race", async () => {
    const request = {
      selectedImage: { id: "selected-race", path: sourcePath, contentHash: sourceHash },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "race-artifacts")
    };
    const results = await Promise.all([compileVisionAsset(request), compileVisionAsset(request)]);
    expect(results.map(({ cache }) => cache).sort()).toEqual(["hit", "miss"]);
    expect(results[0].manifestPath).toBe(results[1].manifestPath);
    VisionAssetManifestSchema.parse(JSON.parse(await readFile(results[0].manifestPath, "utf8")));
  }, 60_000);

  test("rejects Selected Image bytes changed after Director acceptance", async () => {
    await writeFile(sourcePath, architecturalPpm());
    await expect(compileVisionAsset({
      selectedImage: { id: "selected-stale", path: sourcePath, contentHash: sourceHash },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "stale-artifacts")
    })).rejects.toMatchObject({ code: "STALE_SELECTED_IMAGE" });
  });
});
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
