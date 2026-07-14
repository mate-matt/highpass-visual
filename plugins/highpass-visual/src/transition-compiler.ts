import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { TransitionIntentSchema, TransitionMethodSchema } from "./director-compiler.js";
import { createSystemCommandProbe, type CommandProbe } from "./runtime-inspection.js";
import { VisionAssetManifestSchema } from "./vision-compiler.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SCHEMA_VERSION = "highpass.transition-asset.v1" as const;
const GENERATOR_VERSION = "0.2.0";
const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();

export const TRANSITION_QUALITY_THRESHOLDS = {
  homography: { minimumMatches: 20, minimumInliers: 12, minimumInlierRatio: 0.35, maximumReprojectionError: 3, minimumOverlapCoverage: 0.45, maximumProjectedAreaRatio: 1.45 },
  opticalFlow: { minimumConfidence: 0.65, maximumOcclusionRatio: 0.35, maximumForwardBackwardError: 1.5, maximumDisplacementRatio: 0.25 },
  contours: { minimumPairs: 1, minimumCoverage: 0.25, minimumConfidence: 0.55 }
} as const;

export const CompileTransitionAssetRequestSchema = z.object({
  outgoingVisionManifestPath: z.string().min(1),
  incomingVisionManifestPath: z.string().min(1),
  transitionIntent: TransitionIntentSchema,
  artifactRoot: z.string().min(1)
}).strict();

const HomographyMetricsSchema = z.object({
  passed: z.boolean(),
  detectedOutgoing: z.number().int().nonnegative(),
  detectedIncoming: z.number().int().nonnegative(),
  filteredMatches: z.number().int().nonnegative(),
  inliers: z.number().int().nonnegative(),
  inlierRatio: z.number().min(0).max(1),
  medianReprojectionError: z.number().nonnegative().nullable(),
  projectedCornersValid: z.boolean(),
  projectedAreaRatio: z.number().nonnegative().nullable(),
  overlapCoverage: z.number().min(0).max(1),
  reasons: z.array(z.string())
}).strict();

const OpticalFlowMetricsSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  occlusionRatio: z.number().min(0).max(1),
  medianForwardBackwardError: z.number().nonnegative().nullable(),
  displacementP95: z.number().nonnegative(),
  displacementRatioP95: z.number().nonnegative(),
  reasons: z.array(z.string())
}).strict();

const ContourMetricsSchema = z.object({
  passed: z.boolean(),
  pairCount: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string())
}).strict();

export const TransitionAssetManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  artifactHash: z.string().regex(HASH_PATTERN),
  generator: z.object({
    name: z.literal("highpass-transition-compiler"),
    version: z.string(),
    opencvVersion: z.string(),
    numpyVersion: z.string(),
    algorithms: z.array(z.string()).min(3)
  }).strict(),
  provenance: z.object({
    sourceHash: z.string().regex(HASH_PATTERN),
    parameterHash: z.string().regex(HASH_PATTERN),
    schemaHash: z.string().regex(HASH_PATTERN),
    generatorHash: z.string().regex(HASH_PATTERN),
    dependencyHash: z.string().regex(HASH_PATTERN)
  }).strict(),
  sources: z.object({
    outgoing: z.object({ visionArtifactHash: z.string().regex(HASH_PATTERN), manifestPath: z.string(), imagePath: z.string(), maskPath: z.string(), distanceFieldPath: z.string() }).strict(),
    incoming: z.object({ visionArtifactHash: z.string().regex(HASH_PATTERN), manifestPath: z.string(), imagePath: z.string(), maskPath: z.string(), distanceFieldPath: z.string() }).strict()
  }).strict(),
  transitionIntent: TransitionIntentSchema,
  thresholds: z.object({
    homography: z.object({ minimumMatches: z.number(), minimumInliers: z.number(), minimumInlierRatio: z.number(), maximumReprojectionError: z.number(), minimumOverlapCoverage: z.number(), maximumProjectedAreaRatio: z.number() }).strict(),
    opticalFlow: z.object({ minimumConfidence: z.number(), maximumOcclusionRatio: z.number(), maximumForwardBackwardError: z.number(), maximumDisplacementRatio: z.number() }).strict(),
    contours: z.object({ minimumPairs: z.number(), minimumCoverage: z.number(), minimumConfidence: z.number() }).strict()
  }).strict(),
  analysis: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), flowScale: z.number().positive() }).strict(),
  metrics: z.object({ homography: HomographyMetricsSchema, opticalFlow: OpticalFlowMetricsSchema, contours: ContourMetricsSchema }).strict(),
  plan: z.object({
    selectedMethod: TransitionMethodSchema,
    fallbackChain: z.array(TransitionMethodSchema).min(1),
    rejectedMethods: z.array(TransitionMethodSchema),
    locked: z.boolean(),
    selectionReason: z.string().min(1)
  }).strict(),
  artifacts: z.object({
    homography: z.array(z.number()).length(9).nullable(),
    flowForwardPath: z.string(),
    flowForwardHash: z.string().regex(HASH_PATTERN),
    flowBackwardPath: z.string(),
    flowBackwardHash: z.string().regex(HASH_PATTERN),
    confidenceForwardPath: z.string(),
    confidenceForwardHash: z.string().regex(HASH_PATTERN),
    confidenceBackwardPath: z.string(),
    confidenceBackwardHash: z.string().regex(HASH_PATTERN),
    occlusionForwardPath: z.string(),
    occlusionForwardHash: z.string().regex(HASH_PATTERN),
    occlusionBackwardPath: z.string(),
    occlusionBackwardHash: z.string().regex(HASH_PATTERN)
  }).strict(),
  contourCorrespondences: z.array(z.object({
    id: z.string(),
    confidence: z.number().min(0).max(1),
    coverage: z.number().min(0).max(1),
    outgoingContourId: z.string(),
    incomingContourId: z.string(),
    outgoing: z.array(PointSchema).length(64),
    incoming: z.array(PointSchema).length(64)
  }).strict()),
  warnings: z.array(z.string())
}).strict();

export const CompileTransitionAssetResultSchema = z.object({
  manifestPath: z.string(),
  artifactHash: z.string().regex(HASH_PATTERN),
  selectedMethod: TransitionMethodSchema,
  cache: z.enum(["hit", "miss"])
}).strict();
export const CompileTransitionAssetToolOutputSchema = z.object({ result: CompileTransitionAssetResultSchema });
export type CompileTransitionAssetRequest = z.infer<typeof CompileTransitionAssetRequestSchema>;
export type CompileTransitionAssetResult = z.infer<typeof CompileTransitionAssetResultSchema>;
export type TransitionCompiler = (request: CompileTransitionAssetRequest) => Promise<CompileTransitionAssetResult>;

export class TransitionCompilerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransitionCompilerError";
  }
}

type TransitionCompilerOptions = { pluginRoot?: string; pythonExecutable?: string; commandProbe?: CommandProbe };

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function defaultPython(pluginRoot: string) {
  if (process.env.HIGHPASS_PYTHON) return process.env.HIGHPASS_PYTHON;
  const managed = process.platform === "win32" ? path.join(pluginRoot, ".venv", "Scripts", "python.exe") : path.join(pluginRoot, ".venv", "bin", "python");
  return existsSync(managed) ? managed : "python3";
}

function workerError(stderr: string) {
  try {
    const parsed = JSON.parse(stderr.trim()) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string" && typeof parsed.message === "string") return new TransitionCompilerError(parsed.code, parsed.message);
  } catch {
    // Keep worker details behind the deep-module boundary.
  }
  return new TransitionCompilerError("TRANSITION_COMPILATION_FAILED", "The pairwise Transition Asset could not be compiled.");
}

async function validManifest(manifestPath: string, artifactHash: string, verifyFiles = true) {
  try {
    const manifest = TransitionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.artifactHash !== artifactHash) return null;
    if (verifyFiles) {
      const files = [
        [manifest.artifacts.flowForwardPath, manifest.artifacts.flowForwardHash],
        [manifest.artifacts.flowBackwardPath, manifest.artifacts.flowBackwardHash],
        [manifest.artifacts.confidenceForwardPath, manifest.artifacts.confidenceForwardHash],
        [manifest.artifacts.confidenceBackwardPath, manifest.artifacts.confidenceBackwardHash],
        [manifest.artifacts.occlusionForwardPath, manifest.artifacts.occlusionForwardHash],
        [manifest.artifacts.occlusionBackwardPath, manifest.artifacts.occlusionBackwardHash]
      ] as const;
      const verified = await Promise.all(files.map(async ([filePath, expected]) => sha256(await readFile(filePath)) === expected));
      if (verified.some((value) => !value)) return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

async function acquireLock(lockPath: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 180_000) await rm(lockPath, { recursive: true, force: true });
      } catch {
        // The competing compiler may have just released the lock.
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new TransitionCompilerError("TRANSITION_CACHE_LOCK_TIMEOUT", "Another pairwise compilation held the cache lock for too long.");
}

function sourceBinding(manifest: z.infer<typeof VisionAssetManifestSchema>, manifestPath: string) {
  const channel = (id: "subject-mask" | "distance-field") => manifest.channels.find((entry) => entry.id === id)!.previewPath;
  return {
    visionArtifactHash: manifest.artifactHash,
    manifestPath,
    imagePath: manifest.source.previewPath,
    maskPath: channel("subject-mask"),
    distanceFieldPath: channel("distance-field")
  };
}

export async function compileTransitionAsset(input: CompileTransitionAssetRequest, options: TransitionCompilerOptions = {}): Promise<CompileTransitionAssetResult> {
  const request = CompileTransitionAssetRequestSchema.parse(input);
  const pluginRoot = path.resolve(options.pluginRoot ?? process.cwd());
  const outgoingManifestPath = path.resolve(request.outgoingVisionManifestPath);
  const incomingManifestPath = path.resolve(request.incomingVisionManifestPath);
  const [outgoing, incoming] = await Promise.all([
    readFile(outgoingManifestPath, "utf8").then((value) => VisionAssetManifestSchema.parse(JSON.parse(value))),
    readFile(incomingManifestPath, "utf8").then((value) => VisionAssetManifestSchema.parse(JSON.parse(value)))
  ]);
  const workerPath = path.join(pluginRoot, "python", "transition_compiler.py");
  let workerBytes: Buffer;
  try {
    workerBytes = await readFile(workerPath);
  } catch {
    throw new TransitionCompilerError("TRANSITION_COMPILER_UNAVAILABLE", "The bundled Transition Compiler worker is unavailable.");
  }
  const probe = options.commandProbe ?? createSystemCommandProbe({ timeoutMs: 120_000, maxOutputBytes: 65_536 });
  const pythonExecutable = options.pythonExecutable ?? defaultPython(pluginRoot);
  const fingerprintResult = await probe.run(pythonExecutable, [workerPath, "--fingerprint"], { timeoutMs: 30_000, maxOutputBytes: 16_384 });
  if (!fingerprintResult.ok) throw new TransitionCompilerError("TRANSITION_COMPILER_UNAVAILABLE", "OpenCV pairwise analysis is unavailable.");
  const fingerprint = JSON.parse(fingerprintResult.stdout.trim()) as { opencvVersion: string; numpyVersion: string; algorithms: string[] };
  const dependencyHash = sha256(stableJson(fingerprint));
  const sourceHash = sha256(stableJson({ outgoing: outgoing.artifactHash, incoming: incoming.artifactHash }));
  const parameterHash = sha256(stableJson({ transitionIntent: request.transitionIntent, thresholds: TRANSITION_QUALITY_THRESHOLDS }));
  const schemaHash = sha256(stableJson(z.toJSONSchema(TransitionAssetManifestSchema)));
  const generatorHash = sha256(Buffer.concat([Buffer.from(GENERATOR_VERSION), workerBytes, Buffer.from(dependencyHash)]));
  const artifactHash = sha256(stableJson({ sourceHash, parameterHash, schemaHash, generatorHash }));
  const artifactRoot = path.resolve(request.artifactRoot);
  const artifactDirectory = path.join(artifactRoot, artifactHash);
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  const cached = await validManifest(manifestPath, artifactHash);
  if (cached) return CompileTransitionAssetResultSchema.parse({ manifestPath, artifactHash, selectedMethod: cached.plan.selectedMethod, cache: "hit" });

  await mkdir(artifactRoot, { recursive: true });
  const release = await acquireLock(`${artifactDirectory}.lock`);
  try {
    const winner = await validManifest(manifestPath, artifactHash);
    if (winner) return CompileTransitionAssetResultSchema.parse({ manifestPath, artifactHash, selectedMethod: winner.plan.selectedMethod, cache: "hit" });
    await rm(artifactDirectory, { recursive: true, force: true });
    const workingDirectory = path.join(artifactRoot, `.${artifactHash}.${randomUUID()}`);
    await mkdir(workingDirectory);
    try {
      const workerRequestPath = path.join(workingDirectory, "request.json");
      await writeFile(workerRequestPath, stableJson({
        schemaVersion: SCHEMA_VERSION,
        artifactHash,
        artifactDirectory,
        generatorVersion: GENERATOR_VERSION,
        fingerprint,
        hashes: { sourceHash, parameterHash, schemaHash, generatorHash, dependencyHash },
        thresholds: TRANSITION_QUALITY_THRESHOLDS,
        transitionIntent: request.transitionIntent,
        outgoing: { ...sourceBinding(outgoing, outgoingManifestPath), maskMethod: outgoing.maskMethod, maskAnalysis: outgoing.maskAnalysis, contours: outgoing.regionContours },
        incoming: { ...sourceBinding(incoming, incomingManifestPath), maskMethod: incoming.maskMethod, maskAnalysis: incoming.maskAnalysis, contours: incoming.regionContours }
      }));
      const result = await probe.run(pythonExecutable, [workerPath, "--request", workerRequestPath, "--output", workingDirectory], { timeoutMs: 120_000, maxOutputBytes: 65_536 });
      if (!result.ok) throw result.timedOut
        ? new TransitionCompilerError("TRANSITION_COMPILATION_TIMEOUT", "Pairwise OpenCV analysis exceeded its two-minute budget.")
        : workerError(result.stderr);
      const compiled = await validManifest(path.join(workingDirectory, "manifest.json"), artifactHash, false);
      if (!compiled) throw new TransitionCompilerError("INVALID_TRANSITION_ASSET", "The Transition Compiler produced an invalid manifest.");
      await rename(workingDirectory, artifactDirectory);
      return CompileTransitionAssetResultSchema.parse({ manifestPath, artifactHash, selectedMethod: compiled.plan.selectedMethod, cache: "miss" });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  } finally {
    await release();
  }
}
