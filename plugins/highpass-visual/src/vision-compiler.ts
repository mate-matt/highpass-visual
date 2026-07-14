import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { createSystemCommandProbe, type CommandProbe } from "./runtime-inspection.js";

const SCHEMA_VERSION = "highpass.vision-asset.v1" as const;
const GENERATOR_VERSION = "0.1.0";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const OpenStrokeSchema = z.object({
  id: z.string(),
  points: z.array(PointSchema).min(2),
  cumulativeLength: z.array(z.number().nonnegative()).min(2),
  length: z.number().nonnegative()
}).refine(({ points }) => {
  const first = points[0];
  const last = points.at(-1);
  return Boolean(first && last && (first.x !== last.x || first.y !== last.y));
}, "Open Strokes must have distinct endpoints");
const EdgeThresholdSchema = z.object({
  low: z.number().int().min(0).max(255),
  high: z.number().int().min(1).max(255)
}).refine(({ low, high }) => low < high, "edge threshold low must be less than high");

export const VisionRecipeSchema = z.object({
  lowFrequencySigma: z.number().min(0.5).max(40),
  strongEdges: EdgeThresholdSchema,
  detailEdges: EdgeThresholdSchema,
  minContourAreaRatio: z.number().min(0).max(0.25),
  simplifyEpsilonRatio: z.number().min(0).max(0.05),
  maxPaths: z.number().int().min(1).max(20_000),
  maxVertices: z.number().int().min(16).max(300_000)
});

export type VisionRecipe = z.infer<typeof VisionRecipeSchema>;

export const DEFAULT_VISION_RECIPE: VisionRecipe = {
  lowFrequencySigma: 4.5,
  strongEdges: { low: 96, high: 192 },
  detailEdges: { low: 28, high: 84 },
  minContourAreaRatio: 0.0005,
  simplifyEpsilonRatio: 0.0015,
  maxPaths: 2_000,
  maxVertices: 30_000
};

export const SelectedImageSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  contentHash: z.string().regex(SHA256_PATTERN),
  maskPath: z.string().min(1).optional()
});

export const CompileVisionAssetRequestSchema = z.object({
  selectedImage: SelectedImageSchema,
  recipe: VisionRecipeSchema,
  artifactRoot: z.string().min(1)
});

export const CompilerFingerprintSchema = z.object({
  opencvVersion: z.string(),
  numpyVersion: z.string(),
  features: z.object({ thinning: z.boolean() })
});

export type CompilerFingerprint = z.infer<typeof CompilerFingerprintSchema>;

export const VisionAssetManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  artifactHash: z.string().regex(SHA256_PATTERN),
  generator: z.object({
    name: z.literal("highpass-vision-compiler"),
    version: z.string(),
    opencvVersion: z.string(),
    numpyVersion: z.string(),
    features: z.record(z.string(), z.boolean())
  }),
  provenance: z.object({
    sourceHash: z.string().regex(SHA256_PATTERN),
    parameterHash: z.string().regex(SHA256_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
    generatorHash: z.string().regex(SHA256_PATTERN),
    dependencyHash: z.string().regex(SHA256_PATTERN)
  }),
  source: z.object({
    selectedImageId: z.string(),
    path: z.string(),
    maskPath: z.string().nullable(),
    imageHash: z.string().regex(SHA256_PATTERN),
    maskHash: z.string().regex(SHA256_PATTERN).nullable(),
    compiledPath: z.string(),
    previewPath: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    previewWidth: z.number().int().positive(),
    previewHeight: z.number().int().positive()
  }),
  maskMethod: z.enum(["explicit", "grabcut", "otsu-morphology", "full-frame-fallback"]),
  maskAnalysis: z.object({
    coverage: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    centralSupport: z.boolean(),
    bounds: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0).max(1),
      height: z.number().min(0).max(1)
    }).strict(),
    fallbackReason: z.string().nullable()
  }).strict(),
  recipe: VisionRecipeSchema,
  channels: z.array(z.object({
    id: z.enum(["low-frequency", "signed-detail", "signed-detail-light", "signed-detail-dark", "strong-edge", "detail-edge", "subject-mask", "distance-field", "foreground-plate", "middle-plate", "background-plate", "depth-proxy"]),
    family: z.enum(["frequency-layer", "edge-layer", "mask", "distance-field", "rgba-plate", "depth-proxy"]),
    path: z.string(),
    previewPath: z.string(),
    format: z.literal("png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    previewWidth: z.number().int().positive(),
    previewHeight: z.number().int().positive(),
    encoding: z.string(),
    zeroValue: z.number().optional(),
    scale: z.number().positive().optional()
  })).length(12),
  regionContours: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    hole: z.boolean(),
    areaRatio: z.number().min(0).max(1),
    points: z.array(PointSchema).min(3)
  })),
  openStrokes: z.array(OpenStrokeSchema),
  complexity: z.object({
    pathCount: z.number().int().nonnegative(),
    vertexCount: z.number().int().nonnegative(),
    edgeDensity: z.number().min(0).max(1),
    saliency: z.object({
      method: z.literal("gradient-magnitude"),
      centroid: PointSchema,
      bounds: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict(),
      covariance: z.object({ xx: z.number().nonnegative(), xy: z.number(), yy: z.number().nonnegative() }).strict(),
      mass: z.number().nonnegative()
    }),
    budgets: z.object({
      maxPaths: z.number().int().positive(),
      maxVertices: z.number().int().positive()
    }),
    warnings: z.array(z.string())
  })
});

export type CompileVisionAssetRequest = z.infer<typeof CompileVisionAssetRequestSchema>;
export type VisionAssetManifest = z.infer<typeof VisionAssetManifestSchema>;

export const CompileVisionAssetResultSchema = z.object({
  manifestPath: z.string(),
  artifactHash: z.string().regex(SHA256_PATTERN),
  cache: z.enum(["hit", "miss"])
});
export const CompileVisionAssetToolOutputSchema = z.object({ result: CompileVisionAssetResultSchema });

export type CompileVisionAssetResult = z.infer<typeof CompileVisionAssetResultSchema>;
export type VisionCompiler = (request: CompileVisionAssetRequest) => Promise<CompileVisionAssetResult>;

export class VisionCompilerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VisionCompilerError";
  }
}

export type VisionCompilerOptions = {
  pluginRoot?: string;
  pythonExecutable?: string;
  commandProbe?: CommandProbe;
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function defaultPython(pluginRoot: string) {
  if (process.env.HIGHPASS_PYTHON) return process.env.HIGHPASS_PYTHON;
  const managed = process.platform === "win32"
    ? path.join(pluginRoot, ".venv", "Scripts", "python.exe")
    : path.join(pluginRoot, ".venv", "bin", "python");
  return existsSync(managed) ? managed : "python3";
}

function safeWorkerError(stderr: string) {
  try {
    const candidate = JSON.parse(stderr.trim()) as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return new VisionCompilerError(candidate.code, candidate.message);
    }
  } catch {
    // Unexpected worker diagnostics stay behind the module boundary.
  }
  return new VisionCompilerError(
    "COMPILATION_FAILED",
    "Vision Asset compilation failed. Verify the Selected Image and recipe, then retry."
  );
}

async function readValidManifest(manifestPath: string, artifactHash: string, verifyChannels = true) {
  try {
    const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.artifactHash !== artifactHash) return null;
    if (verifyChannels) {
      await Promise.all([
        access(manifest.source.compiledPath),
        access(manifest.source.previewPath),
        ...manifest.channels.flatMap((channel) => [access(channel.path), access(channel.previewPath)])
      ]);
    }
    return manifest;
  } catch {
    return null;
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireArtifactLock(lockPath: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 150_000) {
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
  throw new VisionCompilerError("CACHE_LOCK_TIMEOUT", "Another Vision Asset compilation held the cache lock for too long.");
}

async function inspectCompilerFingerprint(
  pythonExecutable: string,
  workerPath: string,
  probe: CommandProbe
): Promise<CompilerFingerprint> {
  const result = await probe.run(
    pythonExecutable,
    [workerPath, "--fingerprint"],
    { timeoutMs: 30_000, maxOutputBytes: 16_384 }
  );
  if (!result.ok) {
    throw result.timedOut
      ? new VisionCompilerError("RUNTIME_INSPECTION_TIMEOUT", "The Vision Compiler runtime inspection timed out.")
      : new VisionCompilerError("COMPILER_UNAVAILABLE", "The isolated OpenCV Vision Compiler runtime is unavailable.");
  }
  try {
    return CompilerFingerprintSchema.parse(JSON.parse(result.stdout.trim()));
  } catch {
    throw new VisionCompilerError("INVALID_RUNTIME", "The Vision Compiler runtime returned an invalid dependency fingerprint.");
  }
}

export async function compileVisionAsset(
  input: CompileVisionAssetRequest,
  options: VisionCompilerOptions = {}
): Promise<CompileVisionAssetResult> {
  const request = CompileVisionAssetRequestSchema.parse(input);
  const pluginRoot = path.resolve(options.pluginRoot ?? process.cwd());
  const sourcePath = path.resolve(request.selectedImage.path);
  const maskPath = request.selectedImage.maskPath ? path.resolve(request.selectedImage.maskPath) : null;
  try {
    await access(sourcePath);
    if (maskPath) await access(maskPath);
  } catch {
    throw new VisionCompilerError("SOURCE_NOT_FOUND", "The Selected Image or its explicit mask could not be read.");
  }

  const workerPath = path.join(pluginRoot, "python", "vision_compiler.py");
  let workerBytes: Buffer;
  try {
    workerBytes = await readFile(workerPath);
  } catch {
    throw new VisionCompilerError("COMPILER_UNAVAILABLE", "The bundled Vision Compiler worker is unavailable.");
  }

  const probe = options.commandProbe ?? createSystemCommandProbe({
    timeoutMs: 120_000,
    maxOutputBytes: 65_536
  });
  const pythonExecutable = options.pythonExecutable ?? defaultPython(pluginRoot);
  const compilerFingerprint = await inspectCompilerFingerprint(pythonExecutable, workerPath, probe);
  const dependencyHash = sha256(stableJson(compilerFingerprint));
  const imageHash = sha256(await readFile(sourcePath));
  if (imageHash !== request.selectedImage.contentHash) {
    throw new VisionCompilerError("STALE_SELECTED_IMAGE", "The Selected Image changed after its content hash was accepted by the Director workflow.");
  }
  const maskHash = maskPath ? sha256(await readFile(maskPath)) : null;
  const sourceHash = sha256(stableJson({
    selectedImageId: request.selectedImage.id,
    sourcePath,
    imageHash,
    maskPath,
    maskHash
  }));
  const parameterHash = sha256(stableJson(request.recipe));
  const schemaHash = sha256(stableJson(z.toJSONSchema(VisionAssetManifestSchema)));
  const generatorHash = sha256(Buffer.concat([
    Buffer.from(GENERATOR_VERSION),
    workerBytes,
    Buffer.from(dependencyHash)
  ]));
  const artifactHash = sha256(stableJson({ sourceHash, parameterHash, schemaHash, generatorHash }));
  const artifactRoot = path.resolve(request.artifactRoot);
  const artifactDirectory = path.join(artifactRoot, artifactHash);
  const manifestPath = path.join(artifactDirectory, "manifest.json");

  if (await readValidManifest(manifestPath, artifactHash)) {
    return CompileVisionAssetResultSchema.parse({ manifestPath, artifactHash, cache: "hit" });
  }

  await mkdir(artifactRoot, { recursive: true });
  const releaseLock = await acquireArtifactLock(`${artifactDirectory}.lock`);
  try {
    if (await readValidManifest(manifestPath, artifactHash)) {
      return CompileVisionAssetResultSchema.parse({ manifestPath, artifactHash, cache: "hit" });
    }

    const quarantinePath = `${artifactDirectory}.invalid.${randomUUID()}`;
    try {
      await rename(artifactDirectory, quarantinePath);
      await rm(quarantinePath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const workingDirectory = path.join(artifactRoot, `.${artifactHash}.${randomUUID()}`);
    await mkdir(workingDirectory, { recursive: true });
    try {
      const workerRequestPath = path.join(workingDirectory, "request.json");
      await writeFile(workerRequestPath, stableJson({
        artifactHash,
        artifactDirectory,
        compilerFingerprint,
        generatorVersion: GENERATOR_VERSION,
        hashes: { sourceHash, parameterHash, schemaHash, generatorHash, dependencyHash },
        selectedImage: { id: request.selectedImage.id, path: sourcePath, maskPath, imageHash, maskHash },
        recipe: request.recipe,
        schemaVersion: SCHEMA_VERSION
      }));

      const result = await probe.run(
        pythonExecutable,
        [workerPath, "--request", workerRequestPath, "--output", workingDirectory],
        { timeoutMs: 120_000, maxOutputBytes: 65_536 }
      );
      if (!result.ok) {
        throw result.timedOut
          ? new VisionCompilerError("COMPILATION_TIMEOUT", "Vision Asset compilation exceeded the two-minute Shot budget.")
          : safeWorkerError(result.stderr);
      }

      const workingManifest = path.join(workingDirectory, "manifest.json");
      if (!await readValidManifest(workingManifest, artifactHash, false)) {
        throw new VisionCompilerError("INVALID_ARTIFACT", "The Vision Compiler produced an invalid artifact manifest.");
      }
      await rename(workingDirectory, artifactDirectory);
      return CompileVisionAssetResultSchema.parse({ manifestPath, artifactHash, cache: "miss" });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  } finally {
    await releaseLock();
  }
}
