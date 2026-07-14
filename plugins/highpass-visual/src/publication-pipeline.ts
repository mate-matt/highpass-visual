import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import * as z from "zod/v4";

import {
  DEFAULT_BROWSER_COMMANDS,
  createSystemCommandProbe,
  resolveLocalExecutable,
  type CommandProbe
} from "./runtime-inspection.js";
import { stableStringify } from "../runtime/shot-sampler-runtime.js";
import { ShotPreviewManifestSchema } from "./preview-builder.js";
import { ShotProgramSchema, sampleShotProgram } from "./shot-sampler.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const PUBLICATION_GENERATOR_VERSION = "0.2.0";
const PUBLICATION_GENERATOR_NAME = "highpass-publication-pipeline" as const;
const MAX_PUBLICATION_FRAMES = 3_600;
const MAX_PUBLICATION_PIXELS = 1_000_000_000;
const GeneratorSchema = z.object({
  name: z.literal(PUBLICATION_GENERATOR_NAME),
  version: z.string().min(1)
});

export const DeliveryProfileSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
  fps: z.number().int().min(1).max(120),
  codec: z.literal("h264"),
  pixelFormat: z.literal("yuv420p")
}).refine(({ width, height }) => width % 2 === 0 && height % 2 === 0, {
  message: "yuv420p delivery dimensions must be even"
});

export const PublishShotRequestSchema = z.object({
  shotProgramPath: z.string().min(1),
  previewIndexPath: z.string().min(1),
  deliveryProfile: DeliveryProfileSchema,
  outputRoot: z.string().min(1)
});

const FrameRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  requestedSceneTime: z.number().nonnegative(),
  sampledSceneTime: z.number().nonnegative(),
  stateHash: z.string().regex(/^[a-f0-9]{16}$/),
  pngHash: z.string().regex(HASH_PATTERN),
  path: z.string(),
  deliveryHash: z.string().regex(HASH_PATTERN)
});

export const FrameManifestSchema = z.object({
  schemaVersion: z.literal("highpass.frame-manifest.v1"),
  generator: GeneratorSchema,
  deliveryHash: z.string().regex(HASH_PATTERN),
  programHash: z.string().regex(HASH_PATTERN),
  expectedFrameCount: z.number().int().positive(),
  frames: z.array(FrameRecordSchema)
});

const MediaEvidenceSchema = z.object({
  frameCount: z.number().int().positive(),
  duration: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  codec: z.string(),
  pixelFormat: z.string(),
  frameRate: z.string()
});
const QualityEvidenceBaseSchema = z.object({
  schemaVersion: z.literal("highpass.quality-evidence.v1"),
  generator: GeneratorSchema,
  deliveryHash: z.string().regex(HASH_PATTERN),
  programHash: z.string().regex(HASH_PATTERN),
  deliveryProfile: DeliveryProfileSchema,
  expectedFrameCount: z.number().int().positive(),
  frameManifestPath: z.string(),
  mp4Path: z.string().nullable(),
  dependencies: z.object({ browserVersion: z.string(), ffmpegVersion: z.string() }),
  selectedFrames: z.array(z.object({
    index: z.number().int().nonnegative(),
    sceneTime: z.number().nonnegative(),
    stateHash: z.string(),
    pngHash: z.string().regex(HASH_PATTERN)
  })).length(3)
});

export const QualityEvidenceSchema = z.discriminatedUnion("status", [
  QualityEvidenceBaseSchema.extend({
    status: z.literal("published"),
    mp4Path: z.string().min(1),
    mp4Hash: z.string().regex(HASH_PATTERN),
    mp4Size: z.number().int().positive(),
    media: MediaEvidenceSchema,
    encodingFailure: z.null()
  }),
  QualityEvidenceBaseSchema.extend({
    status: z.literal("lossless-fallback"),
    mp4Path: z.null(),
    mp4Hash: z.null(),
    mp4Size: z.null(),
    media: z.null(),
    encodingFailure: z.object({ code: z.literal("ENCODING_FAILED"), message: z.string().min(1) })
  })
]);

export const PublishShotResultSchema = z.object({
  status: z.enum(["published", "lossless-fallback"]),
  deliveryHash: z.string().regex(HASH_PATTERN),
  mp4Path: z.string().nullable(),
  frameManifestPath: z.string(),
  qualityEvidencePath: z.string(),
  expectedFrameCount: z.number().int().positive(),
  renderedFrames: z.number().int().nonnegative(),
  reusedFrames: z.number().int().nonnegative()
});

export const PublishShotToolOutputSchema = z.object({ result: PublishShotResultSchema });
export type PublishShotRequest = z.infer<typeof PublishShotRequestSchema>;
export type PublishShotResult = z.infer<typeof PublishShotResultSchema>;
export type Publisher = (request: PublishShotRequest) => Promise<PublishShotResult>;

export class PublicationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PublicationError";
  }
}

export type PublicationOptions = {
  browserExecutable?: string;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
  commandProbe?: CommandProbe;
  generatorVersion?: string;
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function atomicWrite(target: string, value: Buffer | string) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, target);
}

async function atomicJson(target: string, value: unknown) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultBrowserExecutable() {
  return DEFAULT_BROWSER_COMMANDS
    .map(resolveLocalExecutable)
    .find((candidate): candidate is string => Boolean(candidate));
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireDeliveryLock(lockPath: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return {
        heartbeat: async () => utimes(lockPath, new Date(), new Date()),
        release: async () => rm(lockPath, { recursive: true, force: true })
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 300_000) {
          const stalePath = `${lockPath}.stale.${randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (errorCode(inspectionError) === "ENOENT") continue;
      }
      await delay(50);
    }
  }
  throw new PublicationError("DELIVERY_LOCK_TIMEOUT", "Another publication held the delivery lock for too long.");
}

async function validFrame(
  recordPath: string,
  expected: {
    index: number;
    requestedSceneTime: number;
    sampledSceneTime: number;
    stateHash: string;
    deliveryHash: string;
    path: string;
  }
) {
  try {
    const record = FrameRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
    if (
      record.index !== expected.index
      || record.requestedSceneTime !== expected.requestedSceneTime
      || record.sampledSceneTime !== expected.sampledSceneTime
      || record.stateHash !== expected.stateHash
      || record.deliveryHash !== expected.deliveryHash
      || path.resolve(record.path) !== path.resolve(expected.path)
    ) {
      return null;
    }
    const bytes = await readFile(record.path);
    return sha256(bytes) === record.pngHash ? record : null;
  } catch {
    return null;
  }
}

async function captureFrame(
  page: Page,
  sceneTime: number,
  width: number,
  height: number
): Promise<{ png: Buffer; stateHash: string }> {
  const captured = await page.evaluate(({ sceneTime, width, height }) => {
    const api = (window as unknown as {
      __highpass: { renderAt(time: number): { stateHash: string } };
    }).__highpass;
    const state = api.renderAt(sceneTime);
    const stage = document.getElementById("stage") as HTMLCanvasElement;
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d")!;
    context.fillStyle = "#000000";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scale = Math.min(width / stage.width, height / stage.height);
    const drawWidth = stage.width * scale;
    const drawHeight = stage.height * scale;
    context.drawImage(stage, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return { dataUrl: output.toDataURL("image/png"), stateHash: state.stateHash };
  }, { sceneTime, width, height });
  const encoded = captured.dataUrl.split(",")[1];
  if (!encoded) throw new PublicationError("FRAME_CAPTURE_FAILED", "The browser did not return a PNG frame.");
  return { png: Buffer.from(encoded, "base64"), stateHash: captured.stateHash };
}

async function dependencyVersions(
  browserExecutable: string,
  ffmpegExecutable: string,
  probe: CommandProbe
) {
  const [browser, ffmpeg] = await Promise.all([
    probe.run(browserExecutable, ["--version"], { timeoutMs: 10_000, maxOutputBytes: 8_192 }),
    probe.run(ffmpegExecutable, ["-version"], { timeoutMs: 10_000, maxOutputBytes: 8_192 })
  ]);
  if (!browser.ok || !ffmpeg.ok) {
    throw new PublicationError("PUBLICATION_RUNTIME_UNAVAILABLE", "Browser capture or FFmpeg is unavailable for publication.");
  }
  return {
    browserVersion: (browser.stdout || browser.stderr).split("\n")[0].trim(),
    ffmpegVersion: (ffmpeg.stdout || ffmpeg.stderr).split("\n")[0].trim()
  };
}

async function inspectMedia(mp4Path: string, ffprobeExecutable: string, probe: CommandProbe) {
  const result = await probe.run(ffprobeExecutable, [
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate,duration:format=duration",
    "-of", "json",
    mp4Path
  ], { timeoutMs: 30_000, maxOutputBytes: 65_536 });
  if (!result.ok) throw new PublicationError("MEDIA_INSPECTION_FAILED", "FFprobe could not inspect the published MP4.");
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const stream = parsed.streams?.[0];
    if (!stream) throw new Error("missing video stream");
    return {
      frameCount: Number(stream.nb_read_frames),
      duration: Number(stream.duration ?? parsed.format?.duration),
      width: Number(stream.width),
      height: Number(stream.height),
      codec: String(stream.codec_name),
      pixelFormat: String(stream.pix_fmt),
      frameRate: String(stream.avg_frame_rate)
    };
  } catch {
    throw new PublicationError("INVALID_MEDIA_REPORT", "FFprobe returned an invalid video report.");
  }
}

function assertMedia(
  media: Awaited<ReturnType<typeof inspectMedia>>,
  profile: z.infer<typeof DeliveryProfileSchema>,
  expectedFrameCount: number,
  expectedDuration: number
) {
  const durationTolerance = 1 / profile.fps + 0.001;
  const [rateNumerator, rateDenominator] = media.frameRate.split("/").map(Number);
  const measuredFps = rateDenominator ? rateNumerator / rateDenominator : rateNumerator;
  if (
    media.frameCount !== expectedFrameCount
    || Math.abs(media.duration - expectedDuration) > durationTolerance
    || media.width !== profile.width
    || media.height !== profile.height
    || media.codec !== "h264"
    || media.pixelFormat !== profile.pixelFormat
    || !Number.isFinite(measuredFps)
    || Math.abs(measuredFps - profile.fps) > 1e-9
  ) {
    throw new PublicationError("INCONSISTENT_DELIVERY", "The encoded media does not match its Delivery Profile or exact frame manifest.");
  }
}

export async function publishShot(
  input: PublishShotRequest,
  options: PublicationOptions = {}
): Promise<PublishShotResult> {
  const request = PublishShotRequestSchema.parse(input);
  const programPath = path.resolve(request.shotProgramPath);
  const previewPath = path.resolve(request.previewIndexPath);
  const program = ShotProgramSchema.parse(JSON.parse(await readFile(programPath, "utf8")));
  const previewDirectory = path.dirname(previewPath);
  if (
    path.basename(previewPath) !== "index.html"
    || path.dirname(programPath) !== previewDirectory
    || path.basename(programPath) !== "shot-program.json"
  ) {
    throw new PublicationError("INVALID_PREVIEW_BINDING", "Publication requires sibling index.html and shot-program.json artifacts from the Preview Builder.");
  }
  const [previewBytes, previewManifest] = await Promise.all([
    readFile(previewPath),
    readFile(path.join(previewDirectory, "preview-manifest.json"), "utf8").then((value) => ShotPreviewManifestSchema.parse(JSON.parse(value)))
  ]);
  const previewHtmlHash = sha256(previewBytes);
  if (
    previewManifest.programHash !== program.programHash
    || previewManifest.htmlHash !== previewHtmlHash
    || path.basename(previewDirectory) !== previewHtmlHash
    || path.basename(path.dirname(previewDirectory)) !== program.programHash
  ) {
    throw new PublicationError("INVALID_PREVIEW_BINDING", "The preview manifest does not bind the supplied Shot Program.");
  }
  const requestedBrowser = options.browserExecutable ?? defaultBrowserExecutable();
  const browserExecutable = requestedBrowser ? (resolveLocalExecutable(requestedBrowser) ?? requestedBrowser) : null;
  if (!browserExecutable) throw new PublicationError("BROWSER_UNAVAILABLE", "A supported Chromium browser is required for publication.");
  const ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
  const ffprobeExecutable = options.ffprobeExecutable ?? "ffprobe";
  const probe = options.commandProbe ?? createSystemCommandProbe({ timeoutMs: 180_000, maxOutputBytes: 65_536 });
  const generator = GeneratorSchema.parse({
    name: PUBLICATION_GENERATOR_NAME,
    version: options.generatorVersion ?? PUBLICATION_GENERATOR_VERSION
  });
  const dependencies = await dependencyVersions(browserExecutable, ffmpegExecutable, probe);
  const deliveryHash = sha256(stableStringify({
    generator,
    programHash: program.programHash,
    deliveryProfile: request.deliveryProfile,
    previewHtmlHash,
    dependencies
  }));
  const expectedFrameCount = Math.round(program.shot.duration * request.deliveryProfile.fps);
  if (Math.abs(expectedFrameCount / request.deliveryProfile.fps - program.shot.duration) > 1e-9) {
    throw new PublicationError("NON_INTEGRAL_FRAME_COUNT", "Shot duration and frame rate must produce an exact integer frame count.");
  }
  const publicationPixels = expectedFrameCount * request.deliveryProfile.width * request.deliveryProfile.height;
  if (expectedFrameCount > MAX_PUBLICATION_FRAMES || publicationPixels > MAX_PUBLICATION_PIXELS) {
    throw new PublicationError(
      "PUBLICATION_BUDGET_EXCEEDED",
      `This delivery requests ${expectedFrameCount} frames and ${publicationPixels} output pixels; split it into shorter Shots or lower the Delivery Profile.`
    );
  }

  const outputRoot = path.resolve(request.outputRoot);
  const outputDirectory = path.join(outputRoot, deliveryHash);
  await mkdir(outputRoot, { recursive: true });
  const deliveryLock = await acquireDeliveryLock(`${outputDirectory}.lock`);
  try {
  const framesDirectory = path.join(outputDirectory, "frames");
  const recordsDirectory = path.join(outputDirectory, "frame-records");
  await Promise.all([mkdir(framesDirectory, { recursive: true }), mkdir(recordsDirectory, { recursive: true })]);

  let browser: Browser | null = null;
  let page: Page | null = null;
  let renderedFrames = 0;
  let reusedFrames = 0;
  const frames: z.infer<typeof FrameRecordSchema>[] = [];
  try {
    for (let index = 0; index < expectedFrameCount; index += 1) {
      const requestedSceneTime = index / request.deliveryProfile.fps;
      const expectedState = sampleShotProgram(program, requestedSceneTime);
      const framePath = path.join(framesDirectory, `frame-${String(index).padStart(6, "0")}.png`);
      const recordPath = path.join(recordsDirectory, `frame-${String(index).padStart(6, "0")}.json`);
      const existing = await validFrame(recordPath, {
        index,
        requestedSceneTime,
        sampledSceneTime: expectedState.sceneTime,
        stateHash: expectedState.stateHash,
        deliveryHash,
        path: framePath
      });
      if (existing) {
        frames.push(existing);
        reusedFrames += 1;
        if (index % 100 === 0) await deliveryLock.heartbeat();
        continue;
      }

      if (!browser) {
        browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
        const context = await browser.newContext();
        page = await context.newPage();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const previewUrl = pathToFileURL(previewPath).href;
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === previewUrl || url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
            await route.continue();
          } else {
            await route.abort("blockedbyclient");
          }
        });
        await page.goto(previewUrl);
        await page.locator('#preview[data-ready="true"]').waitFor();
      }
      const captured = await captureFrame(
        page!,
        requestedSceneTime,
        request.deliveryProfile.width,
        request.deliveryProfile.height
      );
      if (captured.stateHash !== expectedState.stateHash) {
        throw new PublicationError("SAMPLER_DIVERGENCE", "Browser and Publication Pipeline sampled different Visual States.");
      }
      await atomicWrite(framePath, captured.png);
      const record = FrameRecordSchema.parse({
        index,
        requestedSceneTime,
        sampledSceneTime: expectedState.sceneTime,
        stateHash: expectedState.stateHash,
        pngHash: sha256(captured.png),
        path: framePath,
        deliveryHash
      });
      await atomicJson(recordPath, record);
      frames.push(record);
      renderedFrames += 1;
      await deliveryLock.heartbeat();
    }
  } finally {
    await browser?.close();
  }

  const frameManifestPath = path.join(outputDirectory, "frames-manifest.json");
  const frameManifest = FrameManifestSchema.parse({
    schemaVersion: "highpass.frame-manifest.v1",
    generator,
    deliveryHash,
    programHash: program.programHash,
    expectedFrameCount,
    frames
  });
  await atomicJson(frameManifestPath, frameManifest);

  const selectedIndices = [0, Math.floor(expectedFrameCount / 2), expectedFrameCount - 1];
  const selectedFrames = selectedIndices.map((index) => ({
    index,
    sceneTime: frames[index].sampledSceneTime,
    stateHash: frames[index].stateHash,
    pngHash: frames[index].pngHash
  }));
  const temporaryMp4Path = path.join(outputDirectory, `.delivery.${randomUUID()}.mp4`);
  await deliveryLock.heartbeat();
  const encoded = await probe.run(ffmpegExecutable, [
    "-loglevel", "error",
    "-framerate", String(request.deliveryProfile.fps),
    "-start_number", "0",
    "-i", path.join(framesDirectory, "frame-%06d.png"),
    "-frames:v", String(expectedFrameCount),
    "-c:v", "libx264",
    "-pix_fmt", request.deliveryProfile.pixelFormat,
    "-movflags", "+faststart",
    temporaryMp4Path
  ], { timeoutMs: 180_000, maxOutputBytes: 65_536 });
  if (!encoded.ok) {
    await rm(temporaryMp4Path, { force: true });
    const qualityEvidencePath = path.join(outputDirectory, "quality-evidence.fallback.json");
    const evidence = QualityEvidenceSchema.parse({
      schemaVersion: "highpass.quality-evidence.v1",
      status: "lossless-fallback",
      generator,
      deliveryHash,
      programHash: program.programHash,
      deliveryProfile: request.deliveryProfile,
      expectedFrameCount,
      frameManifestPath,
      mp4Path: null,
      mp4Hash: null,
      mp4Size: null,
      dependencies,
      media: null,
      encodingFailure: {
        code: "ENCODING_FAILED",
        message: "FFmpeg could not encode the exact-frame MP4; the complete lossless PNG sequence remains available."
      },
      selectedFrames
    });
    await atomicJson(qualityEvidencePath, evidence);
    return PublishShotResultSchema.parse({
      status: "lossless-fallback",
      deliveryHash,
      mp4Path: null,
      frameManifestPath,
      qualityEvidencePath,
      expectedFrameCount,
      renderedFrames,
      reusedFrames
    });
  }

  try {
    const media = await inspectMedia(temporaryMp4Path, ffprobeExecutable, probe);
    assertMedia(media, request.deliveryProfile, expectedFrameCount, program.shot.duration);
    const mp4Hash = await sha256File(temporaryMp4Path);
    const mp4Size = (await stat(temporaryMp4Path)).size;
    const mp4Path = path.join(outputDirectory, "delivery.mp4");
    await rename(temporaryMp4Path, mp4Path);
    const qualityEvidencePath = path.join(outputDirectory, "quality-evidence.json");
  const evidence = QualityEvidenceSchema.parse({
    schemaVersion: "highpass.quality-evidence.v1",
    status: "published",
    generator,
    deliveryHash,
    programHash: program.programHash,
    deliveryProfile: request.deliveryProfile,
    expectedFrameCount,
    frameManifestPath,
    mp4Path,
    mp4Hash,
    mp4Size,
    dependencies,
    media,
    encodingFailure: null,
    selectedFrames
  });
  await atomicJson(qualityEvidencePath, evidence);
  return PublishShotResultSchema.parse({
    status: "published",
    deliveryHash,
    mp4Path,
    frameManifestPath,
    qualityEvidencePath,
    expectedFrameCount,
    renderedFrames,
    reusedFrames
  });
  } finally {
    await rm(temporaryMp4Path, { force: true });
  }
  } finally {
    await deliveryLock.release();
  }
}

export async function verifyDelivery(
  qualityEvidencePath: string,
  options: Pick<PublicationOptions, "ffprobeExecutable" | "commandProbe"> = {}
) {
  const evidencePath = path.resolve(qualityEvidencePath);
  const evidence = QualityEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8")));
  const deliveryDirectory = path.dirname(evidencePath);
  const expectedManifestPath = path.join(deliveryDirectory, "frames-manifest.json");
  if (path.resolve(evidence.frameManifestPath) !== expectedManifestPath) {
    throw new PublicationError("QUALITY_EVIDENCE_MISMATCH", "Quality Evidence points outside its content-addressed delivery.");
  }
  const frameManifest = FrameManifestSchema.parse(JSON.parse(await readFile(evidence.frameManifestPath, "utf8")));
  if (
    frameManifest.frames.length !== evidence.expectedFrameCount
    || frameManifest.expectedFrameCount !== evidence.expectedFrameCount
    || frameManifest.deliveryHash !== evidence.deliveryHash
    || frameManifest.programHash !== evidence.programHash
    || stableStringify(frameManifest.generator) !== stableStringify(evidence.generator)
  ) {
    throw new PublicationError("INCOMPLETE_FRAME_MANIFEST", "The delivery frame manifest is incomplete.");
  }
  const seenPaths = new Set<string>();
  for (let index = 0; index < frameManifest.frames.length; index += 1) {
    const frame = frameManifest.frames[index];
    const requestedSceneTime = index / evidence.deliveryProfile.fps;
    const expectedPath = path.join(deliveryDirectory, "frames", `frame-${String(index).padStart(6, "0")}.png`);
    if (
      frame.index !== index
      || frame.requestedSceneTime !== requestedSceneTime
      || frame.sampledSceneTime !== Number(requestedSceneTime.toFixed(6))
      || frame.deliveryHash !== evidence.deliveryHash
      || path.resolve(frame.path) !== expectedPath
      || seenPaths.has(expectedPath)
    ) {
      throw new PublicationError("INCOMPLETE_FRAME_MANIFEST", `Frame record ${index} is duplicated, reordered, foreign, or sampled at the wrong Scene Time.`);
    }
    seenPaths.add(expectedPath);
  }
  for (const selected of evidence.selectedFrames) {
    const manifestFrame = frameManifest.frames[selected.index];
    if (
      !manifestFrame
      || manifestFrame.sampledSceneTime !== selected.sceneTime
      || manifestFrame.stateHash !== selected.stateHash
      || manifestFrame.pngHash !== selected.pngHash
    ) {
      throw new PublicationError("QUALITY_EVIDENCE_MISMATCH", `Selected frame ${selected.index} does not match the frame manifest.`);
    }
  }
  for (const frame of frameManifest.frames) {
    const bytes = await readFile(frame.path);
    if (sha256(bytes) !== frame.pngHash) {
      throw new PublicationError("FRAME_HASH_MISMATCH", `Frame ${frame.index} no longer matches its Quality Evidence.`);
    }
  }
  if (evidence.status === "lossless-fallback") return evidence;
  if (path.resolve(evidence.mp4Path) !== path.join(deliveryDirectory, "delivery.mp4")) {
    throw new PublicationError("QUALITY_EVIDENCE_MISMATCH", "Quality Evidence points to a foreign MP4.");
  }
  await access(evidence.mp4Path);
  const [mp4Hash, mp4Stat] = await Promise.all([sha256File(evidence.mp4Path), stat(evidence.mp4Path)]);
  if (mp4Hash !== evidence.mp4Hash || mp4Stat.size !== evidence.mp4Size) {
    throw new PublicationError("QUALITY_EVIDENCE_MISMATCH", "The MP4 bytes no longer match Quality Evidence.");
  }
  const probe = options.commandProbe ?? createSystemCommandProbe({ timeoutMs: 30_000, maxOutputBytes: 65_536 });
  const media = await inspectMedia(evidence.mp4Path, options.ffprobeExecutable ?? "ffprobe", probe);
  assertMedia(media, evidence.deliveryProfile, evidence.expectedFrameCount, evidence.deliveryProfile.fps
    ? evidence.expectedFrameCount / evidence.deliveryProfile.fps
    : media.duration);
  if (stableStringify(media) !== stableStringify(evidence.media)) {
    throw new PublicationError("QUALITY_EVIDENCE_MISMATCH", "The current media inspection does not match recorded Quality Evidence.");
  }
  return evidence;
}
