import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { prepareInkRevealPreview } from "../src/preview-builder.js";
import { DEFAULT_BROWSER_COMMANDS, resolveLocalExecutable } from "../src/runtime-inspection.js";
import { sampleTransitionProgram, TransitionProgramSchema } from "../src/transition-program.js";
import { compileTransitionAsset } from "../src/transition-compiler.js";
import { prepareTransitionProgram } from "../src/transition-preview-builder.js";
import { DEFAULT_VISION_RECIPE, compileVisionAsset } from "../src/vision-compiler.js";

const browserPath = DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));

function structuredPpm(shiftX = 0, shiftY = 0, width = 256, height = 192) {
  const pixels = Buffer.alloc(width * height * 3, 228);
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    x += shiftX; y += shiftY;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b;
  };
  for (let y = 18; y < height - 18; y += 1) for (let x = 24; x < width - 24; x += 1) {
    if (((x - 128) / 78) ** 2 + ((y - 96) / 64) ** 2 >= 1) continue;
    const checker = (Math.floor(x / 11) + Math.floor(y / 13)) % 2 === 0;
    paint(x, y, checker ? 31 : 88, checker ? 48 : 111, checker ? 77 : 146);
  }
  for (let index = 0; index < 36; index += 1) {
    const x = 31 + (index * 47 % 190), y = 24 + (index * 61 % 140);
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) if (dx * dx + dy * dy <= 9) paint(x + dx, y + dy, 220, 74 + index % 90, 35);
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("all Transition renderers in Chromium", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "highpass-transition-browser-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test.skipIf(!browserPath)("renders opaque deterministic endpoints and Cross-Dissolve reduced-motion fallback for all five methods", async () => {
    const vision = async (id: string, bytes: Buffer) => {
      const sourcePath = path.join(root, `${id}.ppm`);
      await writeFile(sourcePath, bytes);
      return compileVisionAsset({
        selectedImage: { id, path: sourcePath, contentHash: createHash("sha256").update(bytes).digest("hex") },
        recipe: DEFAULT_VISION_RECIPE,
        artifactRoot: path.join(root, "vision")
      });
    };
    const outgoingVision = await vision("outgoing", structuredPpm());
    const incomingVision = await vision("incoming", structuredPpm(4, 3));
    const methods = [
      ["cross-dissolve", "continuity"],
      ["distance-field-wipe", "atmospheric"],
      ["homography-dissolve", "continuity"],
      ["optical-flow-dissolve", "continuity"],
      ["contour-morph", "reveal"]
    ] as const;
    const previews = [];
    for (const [method, intent] of methods) {
      const transitionIntent = { intent, duration: 1, lockedMethod: method, reason: `Exercise the ${method} renderer with recorded quality evidence.` } as const;
      const asset = await compileTransitionAsset({
        outgoingVisionManifestPath: outgoingVision.manifestPath,
        incomingVisionManifestPath: incomingVision.manifestPath,
        transitionIntent,
        artifactRoot: path.join(root, "transitions")
      });
      const outgoing = await prepareInkRevealPreview({
        shotId: `outgoing-${method}`,
        attentionTarget: "the translated central structure",
        duration: 8,
        transitionOut: transitionIntent,
        visionAssetManifestPath: outgoingVision.manifestPath,
        outputDirectory: path.join(root, "shot-previews")
      });
      const incoming = await prepareInkRevealPreview({
        shotId: `incoming-${method}`,
        attentionTarget: "the arriving central structure",
        duration: 8,
        transitionOut: { intent: "terminal", duration: 0, lockedMethod: "cut", reason: "Hold the incoming image." },
        visionAssetManifestPath: incomingVision.manifestPath,
        outputDirectory: path.join(root, "shot-previews")
      });
      const preview = await prepareTransitionProgram({
        outgoingShotProgramPath: outgoing.shotProgramPath,
        outgoingPreviewIndexPath: outgoing.indexPath,
        incomingShotProgramPath: incoming.shotProgramPath,
        incomingPreviewIndexPath: incoming.indexPath,
        transitionAssetManifestPath: asset.manifestPath,
        outputDirectory: path.join(root, "transition-previews")
      });
      const program = TransitionProgramSchema.parse(JSON.parse(await readFile(preview.transitionProgramPath, "utf8")));
      previews.push({ method, preview, program });
    }

    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      for (const { method, preview, program } of previews) {
        const page = await browser.newPage();
        await page.goto(pathToFileURL(preview.indexPath).href);
        await page.locator('#transition[data-ready="true"]').waitFor({ timeout: 30_000 });
        const snapshot = (time: number, reduced: boolean) => page.evaluate(({ time, reduced }) => {
          const checkbox = document.getElementById("reduced") as HTMLInputElement;
          checkbox.checked = reduced;
          const api = (window as unknown as { __highpassTransition: { renderAt(value: number): { stateHash: string; spatialWarp: number } } }).__highpassTransition;
          const state = api.renderAt(time);
          const canvas = document.getElementById("stage") as HTMLCanvasElement;
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          const main = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const outgoing = (document.getElementById("outgoing") as HTMLIFrameElement).contentDocument!.getElementById("stage") as HTMLCanvasElement;
          const incoming = (document.getElementById("incoming") as HTMLIFrameElement).contentDocument!.getElementById("stage") as HTMLCanvasElement;
          const left = outgoing.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
          const right = incoming.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
          let minimumAlpha = 255, crossError = 0;
          const blend = Math.max(0, Math.min(1, time));
          for (let index = 0; index < main.length; index += 4) {
            minimumAlpha = Math.min(minimumAlpha, main[index + 3]);
            for (let channel = 0; channel < 3; channel += 1) crossError = Math.max(crossError, Math.abs(main[index + channel] - Math.round(left[index + channel] * (1 - blend) + right[index + channel] * blend)));
          }
          return { mainUrl: canvas.toDataURL(), outgoingUrl: outgoing.toDataURL(), incomingUrl: incoming.toDataURL(), minimumAlpha, crossError, stateHash: state.stateHash, spatialWarp: state.spatialWarp };
        }, { time, reduced });
        const start = await snapshot(0, false);
        const middle = await snapshot(0.5, false);
        const repeatedMiddle = await snapshot(0.5, false);
        const end = await snapshot(1, false);
        expect(start.mainUrl, `${method} outgoing endpoint`).toBe(start.outgoingUrl);
        expect(end.mainUrl, `${method} incoming endpoint`).toBe(end.incomingUrl);
        expect(middle.mainUrl).not.toBe(middle.outgoingUrl);
        expect(middle.mainUrl).not.toBe(middle.incomingUrl);
        expect(repeatedMiddle.mainUrl, `${method} deterministic midpoint`).toBe(middle.mainUrl);
        expect(middle.minimumAlpha, `${method} opaque midpoint`).toBe(255);
        expect(middle.stateHash).toBe(sampleTransitionProgram(program, 0.5).stateHash);
        const reduced = await snapshot(0.5, true);
        expect(reduced.stateHash).toBe(sampleTransitionProgram(program, 0.5, { reducedMotion: true }).stateHash);
        expect(reduced.spatialWarp).toBe(0);
        expect(reduced.crossError, `${method} reduced-motion Cross Dissolve error`).toBeLessThanOrEqual(2);
        expect(reduced.minimumAlpha).toBe(255);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 180_000);
});
