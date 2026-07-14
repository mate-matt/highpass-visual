import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MAX_PREVIEW_PIXELS, boundedPreviewSize, prepareInkRevealPreview, prepareTreatmentComparison } from "../src/preview-builder.js";
import { ShotProgramSchema, sampleShotProgram } from "../src/shot-sampler.js";
import { DEFAULT_BROWSER_COMMANDS, resolveLocalExecutable } from "../src/runtime-inspection.js";
import { DEFAULT_VISION_RECIPE, compileVisionAsset } from "../src/vision-compiler.js";

const browserPath = DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));

function previewFixture(width = 64, height = 48) {
  const pixels = Buffer.alloc(width * height * 3, 238);
  for (let y = 7; y < 42; y += 1) {
    for (let x = 9; x < 55; x += 1) {
      const offset = (y * width + x) * 3;
      const border = x < 13 || x > 50 || y < 11 || y > 38;
      pixels[offset] = border ? 20 : 66 + ((x + y) % 7) * 8;
      pixels[offset + 1] = border ? 31 : 82;
      pixels[offset + 2] = border ? 49 : 118;
    }
  }
  for (let y = 19; y < 29; y += 1) {
    for (let x = 27; x < 37; x += 1) {
      const offset = (y * width + x) * 3;
      pixels.fill(238, offset, offset + 3);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("bounded preview sizing", () => {
  test("caps large source imagery without changing aspect ratio", () => {
    const size = boundedPreviewSize(4000, 6000);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PREVIEW_PIXELS);
    expect(size.width / size.height).toBeCloseTo(2 / 3, 2);
  });
});

describe("Ink Reveal browser preview", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-preview-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("shows controls and preserves deterministic seeking, playback, and reduced motion", async () => {
    expect(browserPath, "A supported Chromium browser is required for preview validation.").toBeDefined();
    const sourcePath = path.join(root, "selected.ppm");
    const sourceBytes = previewFixture();
    await writeFile(sourcePath, sourceBytes);
    const vision = await compileVisionAsset({
      selectedImage: { id: "preview-selected", path: sourcePath, contentHash: createHash("sha256").update(sourceBytes).digest("hex") },
      recipe: DEFAULT_VISION_RECIPE,
      artifactRoot: path.join(root, "vision")
    });
    const previewRoot = path.join(root, "preview");
    await mkdir(previewRoot);
    await writeFile(path.join(previewRoot, "index.html"), "untouched");
    const preview = await prepareInkRevealPreview({
      shotId: "shot-preview",
      attentionTarget: "the illuminated doorway",
      duration: 10,
      visionAssetManifestPath: vision.manifestPath,
      outputDirectory: previewRoot
    });
    const comparison = await prepareTreatmentComparison({
      shotId: "shot-preview",
      attentionTarget: "the illuminated doorway",
      duration: 10,
      seed: "browser-comparison-seed",
      visionAssetManifestPath: vision.manifestPath,
      outputDirectory: path.join(root, "comparison")
    });
    expect(await readFile(path.join(previewRoot, "index.html"), "utf8")).toBe("untouched");

    const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(pathToFileURL(preview.indexPath).href);
      try {
        await page.locator('#preview[data-ready="true"]').waitFor({ timeout: 10_000 });
      } catch {
        const previewError = await page.locator("#preview").getAttribute("data-error");
        throw new Error(`Preview did not become ready: ${previewError ?? pageErrors.join(" | ")}`);
      }
      for (const selector of ["#play", "#pause", "#restart", "#seek", "#speed", "#reduced"]) {
        await expect(page.locator(selector).isVisible()).resolves.toBe(true);
      }

      const renderAt = (time: number) => page.evaluate((nextTime) => {
        return (window as unknown as { __highpass: { renderAt(time: number): unknown } }).__highpass.renderAt(nextTime);
      }, time);
      const first = await renderAt(5.375) as { stateHash: string; activePhase: string };
      await renderAt(9.2);
      const sought = await renderAt(5.375) as { stateHash: string; activePhase: string };
      expect(sought).toEqual(first);
      expect(sought.activePhase).toBe("inward-reveal");
      const shotProgram = ShotProgramSchema.parse(JSON.parse(await readFile(preview.shotProgramPath, "utf8")));
      expect(first.stateHash).toBe(sampleShotProgram(shotProgram, 5.375).stateHash);

      const observationStart = await renderAt(8) as { layers: Record<string, number> };
      const observationEnd = await renderAt(9.75) as { layers: Record<string, number> };
      expect(observationEnd.layers).toEqual(observationStart.layers);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.locator('#preview[data-reduced="true"]').waitFor();
      await expect(page.locator("#reduced").isChecked()).resolves.toBe(true);
      const reducedState = await renderAt(5.2) as { reducedMotion: boolean; layers: { blurPx: number } };
      expect(reducedState.reducedMotion).toBe(true);
      expect(reducedState.layers.blurPx).toBe(0);

      await page.locator("#reduced").uncheck();
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator("#reduced").isChecked()).resolves.toBe(false);

      await page.locator("#restart").click();
      await page.locator("#play").click();
      await page.waitForTimeout(120);
      await page.locator("#pause").click();
      const playedTime = await page.evaluate(() => (
        window as unknown as { __highpass: { state: { sceneTime: number } } }
      ).__highpass.state.sceneTime);
      expect(playedTime).toBeGreaterThan(0);
      expect(await page.locator("#stage").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL().length)).toBeGreaterThan(200);
      const benchmark = await page.evaluate(() => (
        window as unknown as { __highpass: { benchmark(frames: number): { averageMs: number } } }
      ).__highpass.benchmark(60));
      expect(benchmark.averageMs).toBeLessThan(20);

      const comparisonPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await comparisonPage.goto(pathToFileURL(comparison.indexPath).href);
      await expect(comparisonPage.locator("iframe").count()).resolves.toBe(3);
      for (let index = 0; index < 3; index += 1) {
        await comparisonPage.frameLocator("iframe").nth(index).locator('#preview[data-ready="true"]').waitFor();
      }
      await comparisonPage.locator("#time").evaluate((element) => {
        const slider = element as HTMLInputElement;
        slider.value = "7.5";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
      for (let index = 0; index < 3; index += 1) {
        const synchronized = await comparisonPage.frameLocator("iframe").nth(index).locator("body").evaluate(() => {
          const highpass = (window as unknown as { __highpass: { state: { sceneTime: number } } }).__highpass;
          const canvas = document.getElementById("stage") as HTMLCanvasElement;
          return { sceneTime: highpass.state.sceneTime, width: canvas.width, height: canvas.height };
        });
        expect(synchronized).toMatchObject({ sceneTime: 7.5, width: 64, height: 48 });
      }
      const renderedHashes: string[] = [];
      for (const programPath of comparison.candidateProgramPaths) {
        const candidatePage = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await candidatePage.goto(pathToFileURL(path.join(path.dirname(programPath), "index.html")).href);
        await candidatePage.locator('#preview[data-ready="true"]').waitFor();
        const candidate = await candidatePage.evaluate(() => (
          window as unknown as { __highpass: { renderAt(time: number): { stateHash: string } } }
        ).__highpass.renderAt(5));
        renderedHashes.push(candidate.stateHash);
        const probeHashes: string[] = [];
        for (const probeTime of [0, 5, 9.5]) {
          await candidatePage.evaluate((time) => (
            window as unknown as { __highpass: { renderAt(time: number): unknown } }
          ).__highpass.renderAt(time), probeTime);
          const dataUrl = await candidatePage.locator("#stage").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
          probeHashes.push(createHash("sha256").update(dataUrl).digest("hex"));
        }
        expect(new Set(probeHashes).size).toBeGreaterThan(1);
        await candidatePage.evaluate(() => (
          window as unknown as { __highpass: { renderAt(time: number): unknown } }
        ).__highpass.renderAt(5));
        const repeated = await candidatePage.locator("#stage").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
        expect(createHash("sha256").update(repeated).digest("hex")).toBe(probeHashes[1]);
        await candidatePage.close();
      }
      expect(new Set(renderedHashes).size).toBe(3);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
