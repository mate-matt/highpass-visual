import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import * as z from "zod/v4";

import { DEFAULT_BROWSER_COMMANDS, resolveLocalExecutable } from "./runtime-inspection.js";
import { DeliveryProfileSchema, PublicationError, type PublicationOptions } from "./publication-pipeline.js";
import { sampleTransitionProgram, TransitionProgramSchema } from "./transition-program.js";
import { TransitionPreviewManifestSchema } from "./transition-preview-builder.js";
import { stableTransitionStringify } from "../runtime/transition-sampler-runtime.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const GENERATOR_VERSION = "0.2.0";

export const PublishTransitionRequestSchema = z.object({
  transitionProgramPath: z.string().min(1),
  previewIndexPath: z.string().min(1),
  deliveryProfile: DeliveryProfileSchema,
  outputRoot: z.string().min(1)
}).strict();

const TransitionFrameRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  transitionTime: z.number().nonnegative(),
  outgoingSceneTime: z.number().nonnegative(),
  incomingSceneTime: z.number().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{16}$/),
  pngHash: z.string().regex(HASH_PATTERN),
  path: z.string(),
  deliveryHash: z.string().regex(HASH_PATTERN)
}).strict();

export const TransitionFrameManifestSchema = z.object({
  schemaVersion: z.literal("highpass.transition-frame-manifest.v1"),
  generator: z.object({ name: z.literal("highpass-transition-publication"), version: z.string() }).strict(),
  deliveryHash: z.string().regex(HASH_PATTERN),
  programHash: z.string().regex(HASH_PATTERN),
  transitionAssetHash: z.string().regex(HASH_PATTERN),
  previewHtmlHash: z.string().regex(HASH_PATTERN),
  dependencies: z.object({ browserPath: z.string(), browserSize: z.number().int().nonnegative(), browserModified: z.number().nonnegative() }).strict(),
  expectedFrameCount: z.number().int().positive(),
  frames: z.array(TransitionFrameRecordSchema)
}).strict();

export const PublishTransitionResultSchema = z.object({
  deliveryHash: z.string().regex(HASH_PATTERN),
  frameManifestPath: z.string(),
  expectedFrameCount: z.number().int().positive(),
  renderedFrames: z.number().int().nonnegative(),
  reusedFrames: z.number().int().nonnegative()
}).strict();

export type PublishTransitionRequest = z.infer<typeof PublishTransitionRequestSchema>;
export type PublishTransitionResult = z.infer<typeof PublishTransitionResultSchema>;

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const atomicWrite = async (target: string, value: Buffer | string) => {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, target);
};

function defaultBrowserExecutable() {
  return DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));
}

async function validFrame(recordPath: string, expected: { index: number; transitionTime: number; outgoingSceneTime: number; incomingSceneTime: number; stateHash: string; deliveryHash: string; path: string }) {
  try {
    const record = TransitionFrameRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
    if (
      record.index !== expected.index
      || record.transitionTime !== expected.transitionTime
      || record.outgoingSceneTime !== expected.outgoingSceneTime
      || record.incomingSceneTime !== expected.incomingSceneTime
      || record.stateHash !== expected.stateHash
      || record.deliveryHash !== expected.deliveryHash
      || path.resolve(record.path) !== path.resolve(expected.path)
    ) return null;
    return sha256(await readFile(record.path)) === record.pngHash ? record : null;
  } catch {
    return null;
  }
}

async function captureFrame(page: Page, transitionTime: number, width: number, height: number) {
  const captured = await page.evaluate(({ transitionTime, width, height }) => {
    const api = (window as unknown as { __highpassTransition: { renderAt(time: number): { stateHash: string } } }).__highpassTransition;
    const state = api.renderAt(transitionTime);
    const stage = document.getElementById("stage") as HTMLCanvasElement;
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d")!;
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scale = Math.min(width / stage.width, height / stage.height);
    const drawWidth = stage.width * scale;
    const drawHeight = stage.height * scale;
    context.drawImage(stage, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return { dataUrl: output.toDataURL("image/png"), stateHash: state.stateHash };
  }, { transitionTime, width, height });
  const encoded = captured.dataUrl.split(",")[1];
  if (!encoded) throw new PublicationError("TRANSITION_FRAME_CAPTURE_FAILED", "The transition renderer did not return a PNG frame.");
  return { png: Buffer.from(encoded, "base64"), stateHash: captured.stateHash };
}

export async function publishTransition(input: PublishTransitionRequest, options: PublicationOptions = {}): Promise<PublishTransitionResult> {
  const request = PublishTransitionRequestSchema.parse(input);
  const transitionProgramPath = path.resolve(request.transitionProgramPath);
  const previewIndexPath = path.resolve(request.previewIndexPath);
  const program = TransitionProgramSchema.parse(JSON.parse(await readFile(transitionProgramPath, "utf8")));
  if (path.dirname(transitionProgramPath) !== path.dirname(previewIndexPath) || path.basename(transitionProgramPath) !== "transition-program.json" || path.basename(previewIndexPath) !== "index.html") {
    throw new PublicationError("TRANSITION_PREVIEW_BINDING_INVALID", "Transition publication requires sibling generated Program and preview files.");
  }
  const previewManifestPath = path.join(path.dirname(previewIndexPath), "preview-manifest.json");
  const [previewHtml, previewManifest] = await Promise.all([
    readFile(previewIndexPath),
    readFile(previewManifestPath, "utf8").then((value) => TransitionPreviewManifestSchema.parse(JSON.parse(value)))
  ]);
  const previewHtmlHash = sha256(previewHtml);
  if (
    previewManifest.programHash !== program.programHash
    || previewManifest.transitionAssetHash !== program.transitionAsset.artifactHash
    || previewManifest.selectedMethod !== program.method
    || previewManifest.htmlHash !== previewHtmlHash
    || path.basename(path.dirname(previewIndexPath)) !== previewHtmlHash
    || path.basename(path.dirname(path.dirname(previewIndexPath))) !== program.programHash
  ) {
    throw new PublicationError("TRANSITION_PREVIEW_BINDING_INVALID", "The Transition preview does not match its Program and Transition Asset.");
  }
  const expectedFrameCount = Math.round(program.duration * request.deliveryProfile.fps);
  if (expectedFrameCount <= 0 || Math.abs(expectedFrameCount / request.deliveryProfile.fps - program.duration) > 1e-9) {
    throw new PublicationError("NON_INTEGRAL_TRANSITION_FRAME_COUNT", "Transition duration and frame rate must produce an exact positive frame count.");
  }
  const browserExecutable = options.browserExecutable ?? defaultBrowserExecutable();
  if (!browserExecutable) throw new PublicationError("BROWSER_UNAVAILABLE", "A supported Chromium browser is required for transition publication.");
  const browserStat = await stat(browserExecutable);
  const dependencies = { browserPath: browserExecutable, browserSize: browserStat.size, browserModified: browserStat.mtimeMs };
  const generator = { name: "highpass-transition-publication" as const, version: options.generatorVersion ?? GENERATOR_VERSION };
  const deliveryHash = sha256(stableTransitionStringify({
    generator,
    programHash: program.programHash,
    transitionAssetHash: program.transitionAsset.artifactHash,
    previewHtmlHash,
    deliveryProfile: request.deliveryProfile,
    browser: dependencies
  }));
  const outputDirectory = path.join(path.resolve(request.outputRoot), deliveryHash);
  const framesDirectory = path.join(outputDirectory, "frames");
  const recordsDirectory = path.join(outputDirectory, "records");
  await Promise.all([mkdir(framesDirectory, { recursive: true }), mkdir(recordsDirectory, { recursive: true })]);
  const frames: z.infer<typeof TransitionFrameRecordSchema>[] = [];
  let renderedFrames = 0;
  let reusedFrames = 0;
  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    for (let index = 0; index < expectedFrameCount; index += 1) {
      const transitionTime = index / request.deliveryProfile.fps;
      const state = sampleTransitionProgram(program, transitionTime);
      const framePath = path.join(framesDirectory, `frame-${String(index).padStart(6, "0")}.png`);
      const recordPath = path.join(recordsDirectory, `frame-${String(index).padStart(6, "0")}.json`);
      const existing = await validFrame(recordPath, { index, transitionTime, outgoingSceneTime: state.outgoingSceneTime, incomingSceneTime: state.incomingSceneTime, stateHash: state.stateHash, deliveryHash, path: framePath });
      if (existing) {
        frames.push(existing);
        reusedFrames += 1;
        continue;
      }
      if (!browser) {
        browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
        page = await browser.newPage();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const previewUrl = pathToFileURL(previewIndexPath).href;
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === previewUrl || url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") await route.continue();
          else await route.abort("blockedbyclient");
        });
        await page.goto(previewUrl);
        await page.locator('#transition[data-ready="true"]').waitFor({ timeout: 30_000 });
      }
      const captured = await captureFrame(page!, transitionTime, request.deliveryProfile.width, request.deliveryProfile.height);
      if (captured.stateHash !== state.stateHash) throw new PublicationError("TRANSITION_SAMPLER_DIVERGENCE", "Browser and Node sampled different Transition States.");
      await atomicWrite(framePath, captured.png);
      const record = TransitionFrameRecordSchema.parse({
        index,
        transitionTime,
        outgoingSceneTime: state.outgoingSceneTime,
        incomingSceneTime: state.incomingSceneTime,
        stateHash: state.stateHash,
        pngHash: sha256(captured.png),
        path: framePath,
        deliveryHash
      });
      await atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      frames.push(record);
      renderedFrames += 1;
    }
  } finally {
    await browser?.close();
  }
  const frameManifestPath = path.join(outputDirectory, "frames-manifest.json");
  await atomicWrite(frameManifestPath, `${JSON.stringify(TransitionFrameManifestSchema.parse({
    schemaVersion: "highpass.transition-frame-manifest.v1",
    generator,
    deliveryHash,
    programHash: program.programHash,
    transitionAssetHash: program.transitionAsset.artifactHash,
    previewHtmlHash,
    dependencies,
    expectedFrameCount,
    frames
  }), null, 2)}\n`);
  return PublishTransitionResultSchema.parse({ deliveryHash, frameManifestPath, expectedFrameCount, renderedFrames, reusedFrames });
}
