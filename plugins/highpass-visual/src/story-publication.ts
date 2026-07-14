import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { DirectorProjectSchema, TransitionMethodSchema } from "./director-compiler.js";
import {
  DeliveryProfileSchema,
  PublicationError,
  FrameManifestSchema,
  PublishShotResultSchema,
  publishShot,
  verifyDelivery,
  type PublicationOptions
} from "./publication-pipeline.js";
import { createSystemCommandProbe, type CommandProbe } from "./runtime-inspection.js";
import { ShotProgramSchema } from "./shot-sampler.js";
import { VisionAssetManifestSchema } from "./vision-compiler.js";
import { TransitionAssetManifestSchema } from "./transition-compiler.js";
import { sampleTransitionProgram, TransitionProgramSchema } from "./transition-program.js";
import { PublishTransitionResultSchema, TransitionFrameManifestSchema, publishTransition } from "./transition-publication.js";
import { stableStringify } from "../runtime/shot-sampler-runtime.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STORY_GENERATOR_NAME = "highpass-story-publication" as const;
export const STORY_PUBLICATION_GENERATOR_VERSION = "0.2.0";

const GeneratorSchema = z.object({
  name: z.literal(STORY_GENERATOR_NAME),
  version: z.string().min(1)
});

const StoryShotInputSchema = z.object({
  shotId: z.string().min(1),
  shotProgramPath: z.string().min(1),
  previewIndexPath: z.string().min(1)
}).strict();

const StoryTransitionInputSchema = z.object({
  outgoingShotId: z.string().min(1),
  incomingShotId: z.string().min(1),
  transitionProgramPath: z.string().min(1),
  previewIndexPath: z.string().min(1)
}).strict();

export const PublishStoryRequestSchema = z.object({
  directorProjectPath: z.string().min(1),
  shots: z.array(StoryShotInputSchema).min(1),
  transitions: z.array(StoryTransitionInputSchema).default([]),
  deliveryProfile: DeliveryProfileSchema,
  audioPath: z.string().min(1).optional(),
  subtitlePath: z.string().min(1).optional(),
  outputRoot: z.string().min(1)
}).strict();

const StoryMediaEvidenceSchema = z.object({
  frameCount: z.number().int().positive(),
  duration: z.number().positive(),
  containerDuration: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  codec: z.string(),
  pixelFormat: z.string(),
  frameRate: z.string(),
  audioPresent: z.boolean(),
  subtitlePresent: z.boolean(),
  audioStart: z.number().nullable(),
  audioDuration: z.number().positive().nullable(),
  subtitleStart: z.number().nullable(),
  subtitleDuration: z.number().positive().nullable()
}).strict();

const SceneRangeSchema = z.object({
  shotId: z.string().min(1),
  beatId: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  transitionIntent: z.enum(["continuity", "reveal", "atmospheric", "dislocation", "terminal"]),
  transitionType: TransitionMethodSchema,
  transitionDuration: z.number().nonnegative(),
  overlapDuration: z.number().nonnegative(),
  transitionReason: z.string().min(1),
  videoFilter: z.string().min(1)
}).strict();

const StoryShotEvidenceSchema = z.object({
  shotId: z.string().min(1),
  beatId: z.string().min(1),
  treatmentId: z.enum(["ink-reveal", "memory-focus", "etched-light"]),
  directionHash: z.string().regex(HASH_PATTERN),
  programHash: z.string().regex(HASH_PATTERN),
  shotProgramPath: z.string().min(1),
  visionAssetHash: z.string().regex(HASH_PATTERN),
  visionManifestPath: z.string().min(1),
  deliveryHash: z.string().regex(HASH_PATTERN),
  frameManifestPath: z.string().min(1),
  qualityEvidencePath: z.string().min(1),
  expectedFrameCount: z.number().int().positive(),
  renderedFrames: z.number().int().nonnegative(),
  reusedFrames: z.number().int().nonnegative(),
  observationHold: z.number().min(2),
  complexity: z.object({
    pathCount: z.number().int().nonnegative(),
    vertexCount: z.number().int().nonnegative(),
    edgeDensity: z.number().min(0).max(1),
    saliency: z.object({
      method: z.literal("gradient-magnitude"),
      centroid: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
      bounds: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict(),
      covariance: z.object({ xx: z.number().nonnegative(), xy: z.number(), yy: z.number().nonnegative() }).strict(),
      mass: z.number().nonnegative()
    }).strict(),
    maxPaths: z.number().int().positive(),
    maxVertices: z.number().int().positive(),
    pathWithinBudget: z.boolean(),
    verticesWithinBudget: z.boolean()
  }).strict(),
  warnings: z.array(z.string()),
  selectedFrames: z.array(z.object({
    index: z.number().int().nonnegative(),
    sceneTime: z.number().nonnegative(),
    stateHash: z.string(),
    pngHash: z.string().regex(HASH_PATTERN)
  }).strict()).length(3)
}).strict();

const SourceTrackSchema = z.object({
  path: z.string().min(1),
  hash: z.string().regex(HASH_PATTERN)
}).strict().nullable();

const StoryTransitionEvidenceSchema = z.object({
  outgoingShotId: z.string().min(1),
  incomingShotId: z.string().min(1),
  programHash: z.string().regex(HASH_PATTERN),
  transitionProgramPath: z.string().min(1),
  transitionAssetHash: z.string().regex(HASH_PATTERN),
  transitionAssetManifestPath: z.string().min(1),
  selectedMethod: z.enum(["cross-dissolve", "distance-field-wipe", "homography-dissolve", "optical-flow-dissolve", "contour-morph"]),
  storyStart: z.number().nonnegative(),
  storyEnd: z.number().positive(),
  duration: z.number().positive(),
  deliveryHash: z.string().regex(HASH_PATTERN),
  previewHtmlHash: z.string().regex(HASH_PATTERN),
  rendererDependencies: TransitionFrameManifestSchema.shape.dependencies,
  frameManifestPath: z.string().min(1),
  expectedFrameCount: z.number().int().positive(),
  renderedFrames: z.number().int().nonnegative(),
  reusedFrames: z.number().int().nonnegative(),
  plan: TransitionAssetManifestSchema.shape.plan,
  metrics: TransitionAssetManifestSchema.shape.metrics,
  thresholds: TransitionAssetManifestSchema.shape.thresholds,
  artifacts: TransitionAssetManifestSchema.shape.artifacts,
  warnings: z.array(z.string())
}).strict();

const StoryFrameRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  storyTime: z.number().nonnegative(),
  kind: z.enum(["shot", "transition"]),
  ownerId: z.string().min(1),
  sourceIndex: z.number().int().nonnegative(),
  sourceTime: z.number().nonnegative(),
  sourcePath: z.string().min(1),
  path: z.string().min(1),
  pngHash: z.string().regex(HASH_PATTERN)
}).strict();

export const StoryFrameManifestSchema = z.object({
  schemaVersion: z.literal("highpass.story-frame-manifest.v1"),
  storyHash: z.string().regex(HASH_PATTERN),
  expectedFrameCount: z.number().int().positive(),
  frames: z.array(StoryFrameRecordSchema)
}).strict();

export const StoryQualityEvidenceSchema = z.object({
  schemaVersion: z.literal("highpass.story-quality-evidence.v1"),
  generator: GeneratorSchema,
  status: z.literal("published"),
  storyHash: z.string().regex(HASH_PATTERN),
  directorHash: z.string().regex(HASH_PATTERN),
  directorProjectPath: z.string().min(1),
  deliveryProfile: DeliveryProfileSchema,
  expectedFrameCount: z.number().int().positive(),
  totalDuration: z.number().positive(),
  sceneRanges: z.array(SceneRangeSchema).min(1),
  shots: z.array(StoryShotEvidenceSchema).min(1),
  transitions: z.array(StoryTransitionEvidenceSchema),
  frameManifestPath: z.string().min(1),
  sourceTracks: z.object({ audio: SourceTrackSchema, subtitles: SourceTrackSchema }).strict(),
  unresolvedWarnings: z.array(z.string()),
  dependencies: z.object({ ffmpegVersion: z.string().min(1), ffprobeVersion: z.string().min(1) }).strict(),
  mp4Path: z.string().min(1),
  mp4Hash: z.string().regex(HASH_PATTERN),
  mp4Size: z.number().int().positive(),
  media: StoryMediaEvidenceSchema,
  evidenceHash: z.string().regex(HASH_PATTERN)
}).strict();

const PublishedStoryShotSchema = z.object({
  shotId: z.string().min(1),
  deliveryHash: z.string().regex(HASH_PATTERN),
  frameManifestPath: z.string().min(1),
  qualityEvidencePath: z.string().min(1),
  renderedFrames: z.number().int().nonnegative(),
  reusedFrames: z.number().int().nonnegative()
}).strict();

export const PublishStoryResultSchema = z.object({
  status: z.literal("published"),
  storyHash: z.string().regex(HASH_PATTERN),
  mp4Path: z.string().min(1),
  qualityEvidencePath: z.string().min(1),
  expectedFrameCount: z.number().int().positive(),
  shots: z.array(PublishedStoryShotSchema).min(1),
  transitions: z.array(z.object({
    outgoingShotId: z.string(),
    incomingShotId: z.string(),
    deliveryHash: z.string().regex(HASH_PATTERN),
    frameManifestPath: z.string(),
    renderedFrames: z.number().int().nonnegative(),
    reusedFrames: z.number().int().nonnegative()
  }).strict())
}).strict();

export const PublishStoryToolOutputSchema = z.object({ result: PublishStoryResultSchema });
export type PublishStoryRequest = z.input<typeof PublishStoryRequestSchema>;
export type PublishStoryResult = z.infer<typeof PublishStoryResultSchema>;
export type StoryPublisher = (request: PublishStoryRequest) => Promise<PublishStoryResult>;
export type StoryPublicationOptions = PublicationOptions & { storyGeneratorVersion?: string };

export class StoryPublicationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "StoryPublicationError";
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function atomicJson(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireStoryLock(lockPath: string) {
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
  throw new StoryPublicationError("STORY_LOCK_TIMEOUT", "Another process held the Story publication lock for too long.");
}

async function runtimeVersions(ffmpegExecutable: string, ffprobeExecutable: string, probe: CommandProbe) {
  const [ffmpeg, ffprobe] = await Promise.all([
    probe.run(ffmpegExecutable, ["-version"], { timeoutMs: 10_000, maxOutputBytes: 8_192 }),
    probe.run(ffprobeExecutable, ["-version"], { timeoutMs: 10_000, maxOutputBytes: 8_192 })
  ]);
  if (!ffmpeg.ok || !ffprobe.ok) {
    throw new StoryPublicationError("STORY_RUNTIME_UNAVAILABLE", "FFmpeg and FFprobe are required for Story publication.");
  }
  return {
    ffmpegVersion: (ffmpeg.stdout || ffmpeg.stderr).split("\n")[0].trim(),
    ffprobeVersion: (ffprobe.stdout || ffprobe.stderr).split("\n")[0].trim()
  };
}

async function inspectStoryMedia(mp4Path: string, ffprobeExecutable: string, probe: CommandProbe) {
  const result = await probe.run(ffprobeExecutable, [
    "-v", "error",
    "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate,start_time,duration:format=duration",
    "-of", "json",
    mp4Path
  ], { timeoutMs: 30_000, maxOutputBytes: 65_536 });
  if (!result.ok) throw new StoryPublicationError("STORY_MEDIA_INSPECTION_FAILED", "FFprobe could not inspect the Story MP4.");
  try {
    const report = JSON.parse(result.stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
    const streams = report.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const subtitles = streams.find((stream) => stream.codec_type === "subtitle");
    if (!video) throw new Error("missing video stream");
    const optionalNumber = (value: unknown) => value === undefined || value === null || value === "N/A"
      ? null
      : Number.isFinite(Number(value)) ? Number(value) : null;
    return StoryMediaEvidenceSchema.parse({
      frameCount: Number(video.nb_read_frames),
      duration: Number(video.duration ?? report.format?.duration),
      containerDuration: Number(report.format?.duration),
      width: Number(video.width),
      height: Number(video.height),
      codec: String(video.codec_name),
      pixelFormat: String(video.pix_fmt),
      frameRate: String(video.avg_frame_rate),
      audioPresent: Boolean(audio),
      subtitlePresent: Boolean(subtitles),
      audioStart: optionalNumber(audio?.start_time),
      audioDuration: optionalNumber(audio?.duration),
      subtitleStart: optionalNumber(subtitles?.start_time),
      subtitleDuration: optionalNumber(subtitles?.duration)
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new StoryPublicationError("INVALID_STORY_MEDIA_REPORT", "FFprobe returned incomplete Story media metadata.");
    }
    throw new StoryPublicationError("INVALID_STORY_MEDIA_REPORT", "FFprobe returned an invalid Story media report.");
  }
}

function assertStoryMedia(
  media: z.infer<typeof StoryMediaEvidenceSchema>,
  profile: z.infer<typeof DeliveryProfileSchema>,
  expectedFrames: number,
  expectedDuration: number,
  audioExpected: boolean,
  subtitlesExpected: boolean
) {
  const [numerator, denominator] = media.frameRate.split("/").map(Number);
  const measuredFps = denominator ? numerator / denominator : numerator;
  const tolerance = 1 / profile.fps + 0.001;
  const audioAligned = !audioExpected || (
    media.audioStart !== null
    && media.audioDuration !== null
    && media.audioStart >= -tolerance
    && media.audioStart + media.audioDuration <= expectedDuration + tolerance
    && Math.abs(media.audioDuration - expectedDuration) <= tolerance
  );
  const subtitlesAligned = !subtitlesExpected || (
    media.subtitleStart !== null
    && media.subtitleDuration !== null
    && media.subtitleStart >= -tolerance
    && media.subtitleStart + media.subtitleDuration <= expectedDuration + tolerance
  );
  if (
    media.frameCount !== expectedFrames
    || Math.abs(media.duration - expectedDuration) > tolerance
    || Math.abs(media.containerDuration - expectedDuration) > tolerance
    || media.width !== profile.width
    || media.height !== profile.height
    || media.codec !== "h264"
    || media.pixelFormat !== profile.pixelFormat
    || !Number.isFinite(measuredFps)
    || Math.abs(measuredFps - profile.fps) > 1e-9
    || media.audioPresent !== audioExpected
    || media.subtitlePresent !== subtitlesExpected
    || !audioAligned
    || !subtitlesAligned
  ) {
    throw new StoryPublicationError("INCONSISTENT_STORY_DELIVERY", "The Story MP4 does not match its scene, frame, track, or Delivery Profile contract.");
  }
}

async function optionalTrack(trackPath: string | undefined) {
  if (!trackPath) return null;
  const resolved = path.resolve(trackPath);
  await access(resolved);
  return { path: resolved, hash: await sha256File(resolved) };
}

function assertInputOrdering(project: z.infer<typeof DirectorProjectSchema>, shots: z.infer<typeof StoryShotInputSchema>[]) {
  if (shots.length !== project.shots.length || new Set(shots.map(({ shotId }) => shotId)).size !== shots.length) {
    throw new StoryPublicationError("STORY_SHOT_SET_INVALID", "Story publication requires exactly one input for every directed Shot.");
  }
  for (let index = 0; index < project.shots.length; index += 1) {
    if (shots[index]?.shotId !== project.shots[index].id) {
      throw new StoryPublicationError("STORY_SHOT_ORDER_INVALID", "Story Shot inputs must preserve canonical Director and Beat order.");
    }
  }
}

async function loadBoundShot(
  project: z.infer<typeof DirectorProjectSchema>,
  input: z.infer<typeof StoryShotInputSchema>,
  index: number
) {
  const directedShot = project.shots[index];
  const selection = project.selections.find(({ shotId }) => shotId === directedShot.id)!;
  const plan = project.shotProgramPlans.find(({ shotId }) => shotId === directedShot.id)!;
  const program = ShotProgramSchema.parse(JSON.parse(await readFile(path.resolve(input.shotProgramPath), "utf8")));
  const vision = VisionAssetManifestSchema.parse(JSON.parse(await readFile(path.resolve(program.visionAsset.manifestPath), "utf8")));
  if (
    program.shot.id !== directedShot.id
    || program.shot.attentionTarget !== directedShot.attentionTarget
    || program.shot.duration !== directedShot.duration
    || program.shot.seed !== plan.seed
    || program.shot.directionHash !== plan.directionHash
    || stableStringify(program.shot.transitionOut) !== stableStringify(directedShot.transitionOut)
    || program.treatment.id !== directedShot.treatmentId
    || program.selectedImage.id !== selection.selectedImage.id
    || program.visionAsset.artifactHash !== vision.artifactHash
    || program.selectedImage.sourceHash !== vision.provenance.sourceHash
    || vision.source.selectedImageId !== selection.selectedImage.id
    || vision.source.imageHash !== selection.selectedImage.contentHash
    || stableStringify(vision.recipe) !== stableStringify(plan.visionRecipe)
  ) {
    throw new StoryPublicationError("STALE_STORY_SHOT_BINDING", `Shot ${directedShot.id} is stale relative to the Director Project, selection, Vision Recipe, or Vision Asset.`);
  }
  return { directedShot, selection, plan, program, vision };
}

function needsPairwiseTransition(transition: z.infer<typeof DirectorProjectSchema>["shots"][number]["transitionOut"]) {
  return (transition.intent === "continuity" || transition.intent === "reveal" || transition.intent === "atmospheric")
    && transition.lockedMethod !== "fade-to-black";
}

async function loadBoundTransitions(
  project: z.infer<typeof DirectorProjectSchema>,
  inputs: z.infer<typeof StoryTransitionInputSchema>[],
  boundShots: Awaited<ReturnType<typeof loadBoundShot>>[]
) {
  const expected = project.shots.slice(0, -1).filter(({ transitionOut }) => needsPairwiseTransition(transitionOut));
  if (inputs.length !== expected.length || new Set(inputs.map(({ outgoingShotId }) => outgoingShotId)).size !== inputs.length) {
    throw new StoryPublicationError("STORY_TRANSITION_SET_INVALID", "Story publication requires exactly one Transition Program for every pairwise Director intent.");
  }
  const output = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const outgoingIndex = project.shots.findIndex(({ id }) => id === input.outgoingShotId);
    if (outgoingIndex < 0 || outgoingIndex >= project.shots.length - 1 || project.shots[outgoingIndex + 1].id !== input.incomingShotId) {
      throw new StoryPublicationError("STORY_TRANSITION_ORDER_INVALID", "Transition inputs must bind adjacent Shots in Director order.");
    }
    const programPath = path.resolve(input.transitionProgramPath);
    const program = TransitionProgramSchema.parse(JSON.parse(await readFile(programPath, "utf8")));
    const assetPath = path.resolve(program.transitionAsset.manifestPath);
    const asset = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(assetPath, "utf8")));
    if (
      program.outgoing.shotId !== input.outgoingShotId
      || program.incoming.shotId !== input.incomingShotId
      || program.outgoing.programHash !== boundShots[outgoingIndex].program.programHash
      || program.incoming.programHash !== boundShots[outgoingIndex + 1].program.programHash
      || program.transitionAsset.artifactHash !== asset.artifactHash
      || stableStringify(program.transitionIntent) !== stableStringify(project.shots[outgoingIndex].transitionOut)
      || program.method !== asset.plan.selectedMethod
    ) {
      throw new StoryPublicationError("STALE_STORY_TRANSITION_BINDING", `Transition ${input.outgoingShotId} → ${input.incomingShotId} is stale relative to its adjacent Shots or Transition Asset.`);
    }
    output.push({ input, outgoingIndex, programPath, program, assetPath, asset });
  }
  output.sort((left, right) => left.outgoingIndex - right.outgoingIndex);
  if (output.some((entry, index) => entry.input.outgoingShotId !== expected[index].id)) {
    throw new StoryPublicationError("STORY_TRANSITION_ORDER_INVALID", "Transition inputs must preserve canonical Director order.");
  }
  return output;
}

type BoundTransition = Awaited<ReturnType<typeof loadBoundTransitions>>[number];

function sceneRanges(project: z.infer<typeof DirectorProjectSchema>, transitions: BoundTransition[]) {
  const byOutgoingIndex = new Map(transitions.map((transition) => [transition.outgoingIndex, transition]));
  let previousEnd = 0;
  let previousOverlap = 0;
  return project.shots.map((shot, index) => {
    const start = index === 0 ? 0 : previousEnd - previousOverlap;
    const end = start + shot.duration;
    const pairwise = byOutgoingIndex.get(index);
    previousEnd = end;
    previousOverlap = pairwise?.program.duration ?? 0;
    const transition = shot.transitionOut;
    return SceneRangeSchema.parse({
      shotId: shot.id,
      beatId: shot.beatId,
      start,
      end,
      transitionIntent: transition.intent,
      transitionType: pairwise?.program.method ?? transition.lockedMethod ?? (transition.intent === "dislocation" || transition.intent === "terminal" ? "cut" : "cross-dissolve"),
      transitionDuration: transition.duration,
      overlapDuration: pairwise?.program.duration ?? 0,
      transitionReason: transition.reason,
      videoFilter: pairwise
        ? `transition-program:${pairwise.program.programHash}`
        : transition.lockedMethod === "fade-to-black"
        ? `shot-program:transitionOpacity:${shot.duration - transition.duration}-${shot.duration}`
        : "shot-program:cut-at-boundary"
    });
  });
}

function storyEncodeArguments(
  framesDirectory: string,
  request: z.infer<typeof PublishStoryRequestSchema>,
  temporaryMp4Path: string,
  expectedFrames: number,
  totalDuration: number
) {
  const args = ["-y", "-loglevel", "error", "-framerate", String(request.deliveryProfile.fps), "-start_number", "0", "-i", path.join(framesDirectory, "frame-%06d.png")];
  const audioIndex = request.audioPath ? 1 : null;
  if (request.audioPath) args.push("-i", path.resolve(request.audioPath));
  const subtitleIndex = request.subtitlePath ? 1 + (request.audioPath ? 1 : 0) : null;
  if (request.subtitlePath) args.push("-i", path.resolve(request.subtitlePath));

  const filters: string[] = [];
  if (audioIndex !== null) {
    filters.push(`[${audioIndex}:a:0]apad,atrim=duration=${totalDuration},asetpts=PTS-STARTPTS[outa]`);
  }
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", "0:v:0");
  if (audioIndex !== null) args.push("-map", "[outa]", "-c:a", "aac");
  if (subtitleIndex !== null) args.push("-map", `${subtitleIndex}:s:0`, "-c:s", "mov_text");
  args.push(
    "-frames:v", String(expectedFrames),
    "-r", String(request.deliveryProfile.fps),
    "-c:v", "libx264",
    "-pix_fmt", request.deliveryProfile.pixelFormat,
    "-movflags", "+faststart",
    "-t", String(totalDuration),
    temporaryMp4Path
  );
  return args;
}

export function planStoryFrameSources(
  shotFrameCounts: number[],
  transitions: Array<{ outgoingIndex: number; frameCount: number }>
) {
  const byOutgoing = new Map(transitions.map((transition) => [transition.outgoingIndex, transition.frameCount]));
  if (byOutgoing.size !== transitions.length) throw new StoryPublicationError("INVALID_STORY_FRAME_PLAN", "A Shot has more than one outgoing pairwise transition.");
  const plan: Array<{ kind: "shot" | "transition"; ownerIndex: number; sourceIndex: number }> = [];
  let previousOverlapFrames = 0;
  for (let shotIndex = 0; shotIndex < shotFrameCounts.length; shotIndex += 1) {
    const outgoingOverlapFrames = byOutgoing.get(shotIndex) ?? 0;
    if (previousOverlapFrames + outgoingOverlapFrames >= shotFrameCounts[shotIndex]) {
      throw new StoryPublicationError("INVALID_STORY_FRAME_PLAN", "Transition overlaps consume an entire adjacent Shot.");
    }
    for (let sourceIndex = previousOverlapFrames; sourceIndex < shotFrameCounts[shotIndex] - outgoingOverlapFrames; sourceIndex += 1) {
      plan.push({ kind: "shot", ownerIndex: shotIndex, sourceIndex });
    }
    for (let sourceIndex = 0; sourceIndex < outgoingOverlapFrames; sourceIndex += 1) {
      plan.push({ kind: "transition", ownerIndex: shotIndex, sourceIndex });
    }
    previousOverlapFrames = outgoingOverlapFrames;
  }
  return plan;
}

async function ensureStoryFrame(sourcePath: string, targetPath: string, expectedHash: string) {
  try {
    if (await sha256File(targetPath) === expectedHash) return;
  } catch {
    // Materialize the absent or invalid frame below.
  }
  await rm(targetPath, { force: true });
  try {
    await link(sourcePath, targetPath);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await copyFile(sourcePath, targetPath);
  }
  if (await sha256File(targetPath) !== expectedHash) {
    throw new StoryPublicationError("STORY_FRAME_HASH_MISMATCH", "A materialized Story frame does not match its source evidence.");
  }
}

async function materializeStoryFrames(
  storyHash: string,
  outputDirectory: string,
  fps: number,
  publishedShots: Array<{ result: z.infer<typeof PublishShotResultSchema> }>,
  publishedTransitions: Array<{ result: z.infer<typeof PublishTransitionResultSchema>; binding: BoundTransition }>,
  expectedFrameCount: number
) {
  const framesDirectory = path.join(outputDirectory, "frames");
  await mkdir(framesDirectory, { recursive: true });
  const transitionsByOutgoing = new Map(publishedTransitions.map((entry) => [entry.binding.outgoingIndex, entry]));
  const shotManifests = await Promise.all(publishedShots.map(({ result }) => readFile(result.frameManifestPath, "utf8").then((value) => FrameManifestSchema.parse(JSON.parse(value)))));
  const transitionManifests = new Map(await Promise.all(publishedTransitions.map(async (entry) => [
    entry.binding.outgoingIndex,
    TransitionFrameManifestSchema.parse(JSON.parse(await readFile(entry.result.frameManifestPath, "utf8")))
  ] as const)));
  const plan = planStoryFrameSources(
    shotManifests.map(({ frames }) => frames.length),
    publishedTransitions.map(({ binding, result }) => ({ outgoingIndex: binding.outgoingIndex, frameCount: result.expectedFrameCount }))
  );
  const records: z.infer<typeof StoryFrameRecordSchema>[] = [];
  for (const planned of plan) {
    const source = planned.kind === "shot"
      ? shotManifests[planned.ownerIndex].frames[planned.sourceIndex]
      : transitionManifests.get(planned.ownerIndex)!.frames[planned.sourceIndex];
    if (!source) throw new StoryPublicationError("INVALID_STORY_FRAME_PLAN", "A Story frame source is missing.");
      const index = records.length;
      const targetPath = path.join(framesDirectory, `frame-${String(index).padStart(6, "0")}.png`);
      await ensureStoryFrame(source.path, targetPath, source.pngHash);
      records.push(StoryFrameRecordSchema.parse({
        index,
        storyTime: index / fps,
        kind: planned.kind,
        ownerId: planned.kind === "shot" ? `shot:${planned.ownerIndex}` : transitionsByOutgoing.get(planned.ownerIndex)!.binding.program.programHash,
        sourceIndex: planned.sourceIndex,
        sourceTime: "sampledSceneTime" in source ? source.sampledSceneTime : source.transitionTime,
        sourcePath: source.path,
        path: targetPath,
        pngHash: source.pngHash
      }));
  }
  if (records.length !== expectedFrameCount) {
    throw new StoryPublicationError("INVALID_STORY_FRAME_PLAN", `Story frame plan contains ${records.length} frames instead of ${expectedFrameCount}.`);
  }
  const frameManifestPath = path.join(outputDirectory, "frames-manifest.json");
  await atomicJson(frameManifestPath, StoryFrameManifestSchema.parse({
    schemaVersion: "highpass.story-frame-manifest.v1",
    storyHash,
    expectedFrameCount,
    frames: records
  }));
  return { frameManifestPath, framesDirectory, records };
}

export async function publishStory(
  input: PublishStoryRequest,
  options: StoryPublicationOptions = {}
): Promise<PublishStoryResult> {
  const request = PublishStoryRequestSchema.parse(input);
  const directorProjectPath = path.resolve(request.directorProjectPath);
  const project = DirectorProjectSchema.parse(JSON.parse(await readFile(directorProjectPath, "utf8")));
  assertInputOrdering(project, request.shots);
  const boundShots = await Promise.all(request.shots.map((shot, index) => loadBoundShot(project, shot, index)));
  const boundTransitions = await loadBoundTransitions(project, request.transitions, boundShots);
  const ranges = sceneRanges(project, boundTransitions);
  const totalDuration = ranges.at(-1)!.end;
  if (Math.abs(totalDuration - project.brief.targetDuration) > 1e-9) {
    throw new StoryPublicationError("STORY_TIME_MISMATCH", "Compiled Transition Programs do not reproduce the Director brief target Story Time.");
  }
  const expectedFrameCount = Math.round(totalDuration * request.deliveryProfile.fps);
  if (Math.abs(expectedFrameCount / request.deliveryProfile.fps - totalDuration) > 1e-9) {
    throw new StoryPublicationError("NON_INTEGRAL_STORY_FRAME_COUNT", "The Story duration and frame rate must produce an exact integer frame count.");
  }

  const outputRoot = path.resolve(request.outputRoot);
  const shotRoot = path.join(outputRoot, "shot-deliveries");
  const publishedShots = [];
  for (let index = 0; index < request.shots.length; index += 1) {
    const shotInput = request.shots[index];
    const result = PublishShotResultSchema.parse(await publishShot({
      shotProgramPath: shotInput.shotProgramPath,
      previewIndexPath: shotInput.previewIndexPath,
      deliveryProfile: request.deliveryProfile,
      outputRoot: path.join(shotRoot, sha256(shotInput.shotId).slice(0, 24))
    }, options));
    if (result.status !== "published" || !result.mp4Path) {
      throw new StoryPublicationError("SHOT_DELIVERY_FALLBACK", `Shot ${shotInput.shotId} could not be encoded; its complete lossless frame sequence remains available.`);
    }
    const quality = await verifyDelivery(result.qualityEvidencePath, options);
    publishedShots.push({ result, quality, mp4Path: result.mp4Path, binding: boundShots[index] });
  }

  const transitionRoot = path.join(outputRoot, "transition-deliveries");
  const publishedTransitions = [];
  for (const binding of boundTransitions) {
    const result = PublishTransitionResultSchema.parse(await publishTransition({
      transitionProgramPath: binding.programPath,
      previewIndexPath: binding.input.previewIndexPath,
      deliveryProfile: request.deliveryProfile,
      outputRoot: path.join(transitionRoot, sha256(`${binding.input.outgoingShotId}:${binding.input.incomingShotId}`).slice(0, 24))
    }, options));
    const frameManifest = TransitionFrameManifestSchema.parse(JSON.parse(await readFile(result.frameManifestPath, "utf8")));
    if (
      frameManifest.programHash !== binding.program.programHash
      || frameManifest.transitionAssetHash !== binding.asset.artifactHash
      || frameManifest.frames.length !== result.expectedFrameCount
    ) {
      throw new StoryPublicationError("STALE_TRANSITION_DELIVERY", `Transition ${binding.input.outgoingShotId} → ${binding.input.incomingShotId} does not match its Program or Asset.`);
    }
    publishedTransitions.push({ result, frameManifest, binding });
  }

  const [audio, subtitles] = await Promise.all([optionalTrack(request.audioPath), optionalTrack(request.subtitlePath)]);
  const ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
  const ffprobeExecutable = options.ffprobeExecutable ?? "ffprobe";
  const probe = options.commandProbe ?? createSystemCommandProbe({ timeoutMs: 180_000, maxOutputBytes: 65_536 });
  const dependencies = await runtimeVersions(ffmpegExecutable, ffprobeExecutable, probe);
  const generator = GeneratorSchema.parse({
    name: STORY_GENERATOR_NAME,
    version: options.storyGeneratorVersion ?? STORY_PUBLICATION_GENERATOR_VERSION
  });
  const storyHash = sha256(stableStringify({
    generator,
    directorHash: project.directorHash,
    deliveryProfile: request.deliveryProfile,
    shots: publishedShots.map(({ result }, index) => ({
      shotId: request.shots[index].shotId,
      deliveryHash: result.deliveryHash,
      transition: project.shots[index].transitionOut
    })),
    transitions: publishedTransitions.map(({ result, binding }) => ({
      outgoingShotId: binding.input.outgoingShotId,
      incomingShotId: binding.input.incomingShotId,
      programHash: binding.program.programHash,
      transitionAssetHash: binding.asset.artifactHash,
      deliveryHash: result.deliveryHash
    })),
    tracks: { audioHash: audio?.hash ?? null, subtitleHash: subtitles?.hash ?? null },
    dependencies
  }));
  await mkdir(outputRoot, { recursive: true });
  const outputDirectory = path.join(outputRoot, storyHash);
  const storyLock = await acquireStoryLock(`${outputDirectory}.lock`);
  try {
    await mkdir(outputDirectory, { recursive: true });
    const temporaryMp4Path = path.join(outputDirectory, `.story.${randomUUID()}.mp4`);
    try {
      await storyLock.heartbeat();
      const storyFrames = await materializeStoryFrames(
        storyHash,
        outputDirectory,
        request.deliveryProfile.fps,
        publishedShots,
        publishedTransitions,
        expectedFrameCount
      );
      const encoded = await probe.run(ffmpegExecutable, storyEncodeArguments(
        storyFrames.framesDirectory,
        request,
        temporaryMp4Path,
        expectedFrameCount,
        totalDuration
      ), { timeoutMs: 180_000, maxOutputBytes: 65_536 });
      if (!encoded.ok) {
        throw new StoryPublicationError("STORY_ENCODING_FAILED", "FFmpeg could not concatenate the directed Shots and source tracks.");
      }
      const media = await inspectStoryMedia(temporaryMp4Path, ffprobeExecutable, probe);
      assertStoryMedia(media, request.deliveryProfile, expectedFrameCount, totalDuration, Boolean(audio), Boolean(subtitles));
      const [mp4Hash, mp4Stat] = await Promise.all([sha256File(temporaryMp4Path), stat(temporaryMp4Path)]);
      const mp4Path = path.join(outputDirectory, "story.mp4");
      await rename(temporaryMp4Path, mp4Path);
      const storyShots = publishedShots.map(({ result, quality, binding }, index) => StoryShotEvidenceSchema.parse({
        shotId: request.shots[index].shotId,
        beatId: binding.directedShot.beatId,
        treatmentId: binding.program.treatment.id,
        directionHash: binding.program.shot.directionHash,
        programHash: binding.program.programHash,
        shotProgramPath: path.resolve(request.shots[index].shotProgramPath),
        visionAssetHash: binding.vision.artifactHash,
        visionManifestPath: path.resolve(binding.program.visionAsset.manifestPath),
        deliveryHash: result.deliveryHash,
        frameManifestPath: result.frameManifestPath,
        qualityEvidencePath: result.qualityEvidencePath,
        expectedFrameCount: result.expectedFrameCount,
        renderedFrames: result.renderedFrames,
        reusedFrames: result.reusedFrames,
        observationHold: binding.program.phases.at(-1)!.end - binding.program.phases.at(-1)!.start,
        complexity: {
          pathCount: binding.vision.complexity.pathCount,
          vertexCount: binding.vision.complexity.vertexCount,
          edgeDensity: binding.vision.complexity.edgeDensity,
          saliency: binding.vision.complexity.saliency,
          maxPaths: binding.vision.complexity.budgets.maxPaths,
          maxVertices: binding.vision.complexity.budgets.maxVertices,
          pathWithinBudget: binding.vision.complexity.pathCount <= binding.vision.complexity.budgets.maxPaths,
          verticesWithinBudget: binding.vision.complexity.vertexCount <= binding.vision.complexity.budgets.maxVertices
        },
        warnings: binding.vision.complexity.warnings,
        selectedFrames: quality.selectedFrames
      }));
      const storyTransitions = publishedTransitions.map(({ result, binding, frameManifest }) => {
        const outgoingRange = ranges[binding.outgoingIndex];
        return StoryTransitionEvidenceSchema.parse({
          outgoingShotId: binding.input.outgoingShotId,
          incomingShotId: binding.input.incomingShotId,
          programHash: binding.program.programHash,
          transitionProgramPath: binding.programPath,
          transitionAssetHash: binding.asset.artifactHash,
          transitionAssetManifestPath: binding.assetPath,
          selectedMethod: binding.program.method,
          storyStart: outgoingRange.end - binding.program.duration,
          storyEnd: outgoingRange.end,
          duration: binding.program.duration,
          deliveryHash: result.deliveryHash,
          previewHtmlHash: frameManifest.previewHtmlHash,
          rendererDependencies: frameManifest.dependencies,
          frameManifestPath: result.frameManifestPath,
          expectedFrameCount: result.expectedFrameCount,
          renderedFrames: result.renderedFrames,
          reusedFrames: result.reusedFrames,
          plan: binding.asset.plan,
          metrics: binding.asset.metrics,
          thresholds: binding.asset.thresholds,
          artifacts: binding.asset.artifacts,
          warnings: binding.asset.warnings
        });
      });
      const qualityEvidencePath = path.join(outputDirectory, "quality-evidence.json");
      const evidenceContent = {
        schemaVersion: "highpass.story-quality-evidence.v1",
        generator,
        status: "published",
        storyHash,
        directorHash: project.directorHash,
        directorProjectPath,
        deliveryProfile: request.deliveryProfile,
        expectedFrameCount,
        totalDuration,
        sceneRanges: ranges,
        shots: storyShots,
        transitions: storyTransitions,
        frameManifestPath: storyFrames.frameManifestPath,
        sourceTracks: { audio, subtitles },
        unresolvedWarnings: [...new Set([
          ...storyShots.flatMap(({ warnings }) => warnings),
          ...storyTransitions.flatMap(({ warnings }) => warnings)
        ])],
        dependencies,
        mp4Path,
        mp4Hash,
        mp4Size: mp4Stat.size,
        media
      } as const;
      const evidence = StoryQualityEvidenceSchema.parse({
        ...evidenceContent,
        evidenceHash: sha256(stableStringify(evidenceContent))
      });
      await atomicJson(qualityEvidencePath, evidence);
      return PublishStoryResultSchema.parse({
        status: "published",
        storyHash,
        mp4Path,
        qualityEvidencePath,
        expectedFrameCount,
        shots: publishedShots.map(({ result }, index) => ({
          shotId: request.shots[index].shotId,
          deliveryHash: result.deliveryHash,
          frameManifestPath: result.frameManifestPath,
          qualityEvidencePath: result.qualityEvidencePath,
          renderedFrames: result.renderedFrames,
          reusedFrames: result.reusedFrames
        })),
        transitions: publishedTransitions.map(({ result, binding }) => ({
          outgoingShotId: binding.input.outgoingShotId,
          incomingShotId: binding.input.incomingShotId,
          deliveryHash: result.deliveryHash,
          frameManifestPath: result.frameManifestPath,
          renderedFrames: result.renderedFrames,
          reusedFrames: result.reusedFrames
        }))
      });
    } finally {
      await rm(temporaryMp4Path, { force: true });
    }
  } finally {
    await storyLock.release();
  }
}

export async function verifyStoryDelivery(
  qualityEvidencePath: string,
  options: Pick<StoryPublicationOptions, "ffprobeExecutable" | "commandProbe"> = {}
) {
  const evidencePath = path.resolve(qualityEvidencePath);
  const evidence = StoryQualityEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8")));
  const { evidenceHash, ...evidenceContent } = evidence;
  if (sha256(stableStringify(evidenceContent)) !== evidenceHash) {
    throw new StoryPublicationError("STORY_QUALITY_EVIDENCE_MISMATCH", "Story Quality Evidence content no longer matches its evidence hash.");
  }
  const deliveryDirectory = path.dirname(evidencePath);
  if (
    path.basename(deliveryDirectory) !== evidence.storyHash
    || path.resolve(evidence.mp4Path) !== path.join(deliveryDirectory, "story.mp4")
    || evidence.sceneRanges.length !== evidence.shots.length
  ) {
    throw new StoryPublicationError("STORY_QUALITY_EVIDENCE_MISMATCH", "Story Quality Evidence points outside its content-addressed delivery or has incomplete scene bindings.");
  }
  const directorProject = DirectorProjectSchema.parse(JSON.parse(await readFile(evidence.directorProjectPath, "utf8")));
  if (directorProject.directorHash !== evidence.directorHash || directorProject.shots.length !== evidence.shots.length) {
    throw new StoryPublicationError("STORY_DIRECTOR_EVIDENCE_MISMATCH", "The Director Project no longer matches Story Quality Evidence.");
  }
  let cursor = 0;
  for (let index = 0; index < evidence.shots.length; index += 1) {
    const shot = evidence.shots[index];
    const range = evidence.sceneRanges[index];
    const directedShot = directorProject.shots[index];
    if (
      range.shotId !== shot.shotId
      || directedShot.id !== shot.shotId
      || directedShot.beatId !== shot.beatId
      || directedShot.treatmentId !== shot.treatmentId
      || directedShot.duration !== range.end - range.start
      || directedShot.transitionOut.intent !== range.transitionIntent
      || (range.overlapDuration === 0
        && (directedShot.transitionOut.lockedMethod ?? (directedShot.transitionOut.intent === "dislocation" || directedShot.transitionOut.intent === "terminal" ? "cut" : "cross-dissolve")) !== range.transitionType)
      || directedShot.transitionOut.duration !== range.transitionDuration
      || directedShot.transitionOut.reason !== range.transitionReason
      || range.start !== (index === 0 ? 0 : evidence.sceneRanges[index - 1].end - evidence.sceneRanges[index - 1].overlapDuration)
      || range.end <= range.start
    ) {
      throw new StoryPublicationError("INCOMPLETE_STORY_TIMELINE", "Story scene ranges are reordered, overlapping, gapped, or incomplete.");
    }
    cursor = range.end;
    const shotEvidence = await verifyDelivery(shot.qualityEvidencePath, options);
    const program = ShotProgramSchema.parse(JSON.parse(await readFile(shot.shotProgramPath, "utf8")));
    const vision = VisionAssetManifestSchema.parse(JSON.parse(await readFile(shot.visionManifestPath, "utf8")));
    const observedComplexity = {
      pathCount: vision.complexity.pathCount,
      vertexCount: vision.complexity.vertexCount,
      edgeDensity: vision.complexity.edgeDensity,
      saliency: vision.complexity.saliency,
      maxPaths: vision.complexity.budgets.maxPaths,
      maxVertices: vision.complexity.budgets.maxVertices,
      pathWithinBudget: vision.complexity.pathCount <= vision.complexity.budgets.maxPaths,
      verticesWithinBudget: vision.complexity.vertexCount <= vision.complexity.budgets.maxVertices
    };
    const observation = program.phases.at(-1)!;
    if (
      shotEvidence.deliveryHash !== shot.deliveryHash
      || shotEvidence.programHash !== shot.programHash
      || shotEvidence.frameManifestPath !== shot.frameManifestPath
      || stableStringify(shotEvidence.deliveryProfile) !== stableStringify(evidence.deliveryProfile)
      || shot.expectedFrameCount !== (range.end - range.start) * evidence.deliveryProfile.fps
      || stableStringify(shotEvidence.selectedFrames) !== stableStringify(shot.selectedFrames)
      || program.programHash !== shot.programHash
      || program.shot.directionHash !== shot.directionHash
      || path.resolve(program.visionAsset.manifestPath) !== path.resolve(shot.visionManifestPath)
      || vision.artifactHash !== shot.visionAssetHash
      || program.visionAsset.artifactHash !== shot.visionAssetHash
      || observation.end - observation.start !== shot.observationHold
      || stableStringify(observedComplexity) !== stableStringify(shot.complexity)
      || stableStringify(vision.complexity.warnings) !== stableStringify(shot.warnings)
    ) {
      throw new StoryPublicationError("STORY_SHOT_EVIDENCE_MISMATCH", `Shot ${shot.shotId} no longer matches Story Quality Evidence.`);
    }
  }
  if (cursor !== evidence.totalDuration) {
    throw new StoryPublicationError("INCOMPLETE_STORY_TIMELINE", "Story duration does not equal its overlap-aware Shot mapping.");
  }
  const expectedTransitionCount = evidence.sceneRanges.filter(({ overlapDuration }) => overlapDuration > 0).length;
  if (evidence.transitions.length !== expectedTransitionCount) {
    throw new StoryPublicationError("INCOMPLETE_STORY_TIMELINE", "Story transition evidence does not cover every shared overlap.");
  }
  for (const transition of evidence.transitions) {
    const outgoingIndex = directorProject.shots.findIndex(({ id }) => id === transition.outgoingShotId);
    const range = evidence.sceneRanges[outgoingIndex];
    const program = TransitionProgramSchema.parse(JSON.parse(await readFile(transition.transitionProgramPath, "utf8")));
    const asset = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(transition.transitionAssetManifestPath, "utf8")));
    const frames = TransitionFrameManifestSchema.parse(JSON.parse(await readFile(transition.frameManifestPath, "utf8")));
    if (
      outgoingIndex < 0
      || directorProject.shots[outgoingIndex + 1]?.id !== transition.incomingShotId
      || program.programHash !== transition.programHash
      || program.transitionAsset.artifactHash !== transition.transitionAssetHash
      || asset.artifactHash !== transition.transitionAssetHash
      || program.method !== transition.selectedMethod
      || stableStringify(asset.plan) !== stableStringify(transition.plan)
      || stableStringify(asset.metrics) !== stableStringify(transition.metrics)
      || stableStringify(asset.thresholds) !== stableStringify(transition.thresholds)
      || stableStringify(asset.artifacts) !== stableStringify(transition.artifacts)
      || stableStringify(asset.warnings) !== stableStringify(transition.warnings)
      || transition.storyStart !== range.end - transition.duration
      || transition.storyEnd !== range.end
      || range.overlapDuration !== transition.duration
      || frames.deliveryHash !== transition.deliveryHash
      || frames.programHash !== transition.programHash
      || frames.transitionAssetHash !== transition.transitionAssetHash
      || frames.previewHtmlHash !== transition.previewHtmlHash
      || stableStringify(frames.dependencies) !== stableStringify(transition.rendererDependencies)
      || frames.frames.length !== transition.expectedFrameCount
      || transition.expectedFrameCount !== transition.duration * evidence.deliveryProfile.fps
    ) {
      throw new StoryPublicationError("STORY_TRANSITION_EVIDENCE_MISMATCH", `Transition ${transition.outgoingShotId} → ${transition.incomingShotId} no longer matches Story Quality Evidence.`);
    }
    const rasterBindings = [
      [asset.artifacts.flowForwardPath, asset.artifacts.flowForwardHash],
      [asset.artifacts.flowBackwardPath, asset.artifacts.flowBackwardHash],
      [asset.artifacts.confidenceForwardPath, asset.artifacts.confidenceForwardHash],
      [asset.artifacts.confidenceBackwardPath, asset.artifacts.confidenceBackwardHash],
      [asset.artifacts.occlusionForwardPath, asset.artifacts.occlusionForwardHash],
      [asset.artifacts.occlusionBackwardPath, asset.artifacts.occlusionBackwardHash]
    ] as const;
    for (const [rasterPath, rasterHash] of rasterBindings) {
      if (await sha256File(rasterPath) !== rasterHash) throw new StoryPublicationError("STORY_TRANSITION_EVIDENCE_MISMATCH", "A Transition renderer raster no longer matches its recorded hash.");
    }
    for (let index = 0; index < frames.frames.length; index += 1) {
      const frame = frames.frames[index];
      const transitionTime = index / evidence.deliveryProfile.fps;
      const sampled = sampleTransitionProgram(program, transitionTime);
      if (
        frame.index !== index
        || frame.transitionTime !== transitionTime
        || frame.outgoingSceneTime !== sampled.outgoingSceneTime
        || frame.incomingSceneTime !== sampled.incomingSceneTime
        || frame.stateHash !== sampled.stateHash
        || frame.deliveryHash !== frames.deliveryHash
        || path.resolve(frame.path) !== path.join(path.dirname(transition.frameManifestPath), "frames", `frame-${String(index).padStart(6, "0")}.png`)
        || await sha256File(frame.path) !== frame.pngHash
      ) throw new StoryPublicationError("STORY_TRANSITION_EVIDENCE_MISMATCH", "A Transition frame no longer matches its sampled Program state or recorded hash.");
    }
  }
  const storyFrameManifest = StoryFrameManifestSchema.parse(JSON.parse(await readFile(evidence.frameManifestPath, "utf8")));
  if (
    path.resolve(evidence.frameManifestPath) !== path.join(deliveryDirectory, "frames-manifest.json")
    || storyFrameManifest.storyHash !== evidence.storyHash
    || storyFrameManifest.expectedFrameCount !== evidence.expectedFrameCount
    || storyFrameManifest.frames.length !== evidence.expectedFrameCount
  ) {
    throw new StoryPublicationError("STORY_FRAME_EVIDENCE_MISMATCH", "The exact Story frame manifest is incomplete or foreign.");
  }
  for (let index = 0; index < storyFrameManifest.frames.length; index += 1) {
    const frame = storyFrameManifest.frames[index];
    if (frame.index !== index || frame.storyTime !== index / evidence.deliveryProfile.fps || await sha256File(frame.path) !== frame.pngHash || await sha256File(frame.sourcePath) !== frame.pngHash) {
      throw new StoryPublicationError("STORY_FRAME_EVIDENCE_MISMATCH", `Story frame ${index} no longer matches its exact source evidence.`);
    }
  }
  for (const track of [evidence.sourceTracks.audio, evidence.sourceTracks.subtitles]) {
    if (track && await sha256File(track.path) !== track.hash) {
      throw new StoryPublicationError("STORY_SOURCE_TRACK_MISMATCH", "An audio or subtitle source no longer matches Story Quality Evidence.");
    }
  }
  const expectedStoryHash = sha256(stableStringify({
    generator: evidence.generator,
    directorHash: evidence.directorHash,
    deliveryProfile: evidence.deliveryProfile,
    shots: evidence.shots.map((shot, index) => ({
      shotId: shot.shotId,
      deliveryHash: shot.deliveryHash,
      transition: directorProject.shots[index].transitionOut
    })),
    transitions: evidence.transitions.map((transition) => ({
      outgoingShotId: transition.outgoingShotId,
      incomingShotId: transition.incomingShotId,
      programHash: transition.programHash,
      transitionAssetHash: transition.transitionAssetHash,
      deliveryHash: transition.deliveryHash
    })),
    tracks: {
      audioHash: evidence.sourceTracks.audio?.hash ?? null,
      subtitleHash: evidence.sourceTracks.subtitles?.hash ?? null
    },
    dependencies: evidence.dependencies
  }));
  if (expectedStoryHash !== evidence.storyHash) {
    throw new StoryPublicationError("STORY_QUALITY_EVIDENCE_MISMATCH", "The Story hash does not match its recorded inputs and generator dependencies.");
  }
  const [mp4Hash, mp4Stat] = await Promise.all([sha256File(evidence.mp4Path), stat(evidence.mp4Path)]);
  if (mp4Hash !== evidence.mp4Hash || mp4Stat.size !== evidence.mp4Size) {
    throw new StoryPublicationError("STORY_QUALITY_EVIDENCE_MISMATCH", "The Story MP4 bytes no longer match Quality Evidence.");
  }
  const probe = options.commandProbe ?? createSystemCommandProbe({ timeoutMs: 30_000, maxOutputBytes: 65_536 });
  const media = await inspectStoryMedia(evidence.mp4Path, options.ffprobeExecutable ?? "ffprobe", probe);
  assertStoryMedia(
    media,
    evidence.deliveryProfile,
    evidence.expectedFrameCount,
    evidence.totalDuration,
    Boolean(evidence.sourceTracks.audio),
    Boolean(evidence.sourceTracks.subtitles)
  );
  if (stableStringify(media) !== stableStringify(evidence.media)) {
    throw new StoryPublicationError("STORY_QUALITY_EVIDENCE_MISMATCH", "Current Story media inspection differs from recorded Quality Evidence.");
  }
  return evidence;
}
