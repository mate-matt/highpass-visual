import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";

import { inkRevealPreviewHtml } from "./preview-template.js";
import {
  ShotProgramSchema,
  TREATMENT_CONTROL_DEFINITIONS,
  TreatmentControlOverridesSchema,
  assertComparableTreatments,
  createInkRevealShotProgram,
  createTreatmentShotProgram,
  ShotTransitionSchema,
  type ShotProgram,
  type TreatmentId
} from "./shot-sampler.js";
import { VisionAssetManifestSchema, type VisionAssetManifest } from "./vision-compiler.js";

export const PrepareInkRevealPreviewRequestSchema = z.object({
  shotId: z.string().min(1),
  attentionTarget: z.string().min(1),
  duration: z.number().min(5).max(120).default(10),
  directionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  transitionOut: ShotTransitionSchema.optional(),
  visionAssetManifestPath: z.string().min(1),
  outputDirectory: z.string().min(1)
});

export const PrepareInkRevealPreviewResultSchema = z.object({
  indexPath: z.string(),
  shotProgramPath: z.string(),
  programHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export const ShotPreviewManifestSchema = z.object({
  schemaVersion: z.literal("highpass.preview.v1"),
  programHash: z.string().regex(/^[a-f0-9]{64}$/),
  treatmentId: z.string(),
  assetResolution: z.enum(["bounded-preview", "full-source"]),
  renderSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), maxPixels: z.number().int().positive() }).strict(),
  htmlHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const PrepareTreatmentComparisonRequestSchema = z.object({
  shotId: z.string().min(1),
  attentionTarget: z.string().min(1),
  duration: z.number().min(5).max(120).default(10),
  seed: z.string().min(1),
  directionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  transitionOut: ShotTransitionSchema.optional(),
  visionAssetManifestPath: z.string().min(1),
  outputDirectory: z.string().min(1),
  controls: TreatmentControlOverridesSchema.optional()
});

export const PrepareTreatmentComparisonResultSchema = z.object({
  indexPath: z.string(),
  comparisonManifestPath: z.string(),
  comparisonHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidateProgramPaths: z.array(z.string()).length(3)
});

export const PrepareInkRevealPreviewToolOutputSchema = z.object({ result: PrepareInkRevealPreviewResultSchema });
export const PrepareTreatmentComparisonToolOutputSchema = z.object({ result: PrepareTreatmentComparisonResultSchema });
export type PrepareInkRevealPreviewRequest = z.infer<typeof PrepareInkRevealPreviewRequestSchema>;
export type PrepareInkRevealPreviewResult = z.infer<typeof PrepareInkRevealPreviewResultSchema>;
export type PrepareTreatmentComparisonRequest = z.infer<typeof PrepareTreatmentComparisonRequestSchema>;
export type PrepareTreatmentComparisonResult = z.infer<typeof PrepareTreatmentComparisonResultSchema>;
export type PreviewBuilder = (request: PrepareInkRevealPreviewRequest) => Promise<PrepareInkRevealPreviewResult>;
export type ComparisonBuilder = (request: PrepareTreatmentComparisonRequest) => Promise<PrepareTreatmentComparisonResult>;
export const MAX_PREVIEW_PIXELS = 1280 * 720;

export function boundedPreviewSize(width: number, height: number) {
  const scale = Math.min(1, Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    maxPixels: MAX_PREVIEW_PIXELS
  };
}

function dataUri(bytes: Buffer) {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function embeddedImages(manifest: VisionAssetManifest, program: ShotProgram, boundedAssets: boolean) {
  const images: Record<string, string> = {
    source: dataUri(await readFile(boundedAssets ? manifest.source.previewPath : manifest.source.compiledPath))
  };
  const required = new Set<string>(program.treatment.requiredChannels);
  for (const id of ["foreground-plate", "middle-plate", "background-plate", "depth-proxy"]) required.add(id);
  for (const channel of manifest.channels) {
    if (required.has(channel.id)) images[channel.id] = dataUri(await readFile(boundedAssets ? channel.previewPath : channel.path));
  }
  return images;
}

function assertTreatmentChannels(program: ShotProgram, manifest: VisionAssetManifest) {
  const available = new Set(manifest.channels.map(({ id }) => id));
  const missing = program.treatment.requiredChannels.filter((id) => !available.has(id));
  if (missing.length) throw new Error(`${program.treatment.id} requires missing Vision Asset channels: ${missing.join(", ")}`);
}

async function prepareProgramPreview(
  program: ShotProgram,
  manifest: VisionAssetManifest,
  outputRootInput: string,
  boundedAssets = false
) {
  assertTreatmentChannels(program, manifest);
  const images = await embeddedImages(manifest, program, boundedAssets);
  const outputRoot = path.resolve(outputRootInput);
  const samplerRuntimeSource = await readFile(path.join(process.cwd(), "runtime", "shot-sampler-runtime.js"), "utf8");
  const renderSize = boundedAssets
    ? { width: manifest.source.previewWidth, height: manifest.source.previewHeight, maxPixels: MAX_PREVIEW_PIXELS }
    : boundedPreviewSize(manifest.source.width, manifest.source.height);
  const html = inkRevealPreviewHtml({ program, manifest, images, renderSize }, samplerRuntimeSource);
  const htmlHash = createHash("sha256").update(html).digest("hex");
  const outputDirectory = path.join(outputRoot, program.programHash, htmlHash);
  const indexPath = path.join(outputDirectory, "index.html");
  const shotProgramPath = path.join(outputDirectory, "shot-program.json");
  const previewManifestPath = path.join(outputDirectory, "preview-manifest.json");
  const assetResolution = boundedAssets ? "bounded-preview" : "full-source";
  try {
    const existing = ShotPreviewManifestSchema.parse(JSON.parse(await readFile(previewManifestPath, "utf8")));
    const [cachedHtml, cachedProgram] = await Promise.all([
      readFile(indexPath),
      readFile(shotProgramPath, "utf8").then((value) => ShotProgramSchema.parse(JSON.parse(value)))
    ]);
    if (existing.programHash !== program.programHash || existing.assetResolution !== assetResolution || existing.htmlHash !== htmlHash || createHash("sha256").update(cachedHtml).digest("hex") !== htmlHash || cachedProgram.programHash !== program.programHash) throw new Error("preview ownership mismatch");
    return PrepareInkRevealPreviewResultSchema.parse({ indexPath, shotProgramPath, programHash: program.programHash });
  } catch {
    // Only an absent content-addressed target is created below.
  }
  await rm(outputDirectory, { recursive: true, force: true });

  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const workingDirectory = path.join(outputRoot, `.${program.programHash}.${randomUUID()}`);
  await mkdir(workingDirectory);
  try {
    await writeFile(path.join(workingDirectory, "shot-program.json"), `${JSON.stringify(ShotProgramSchema.parse(program), null, 2)}\n`);
    await writeFile(path.join(workingDirectory, "index.html"), html);
    await writeFile(path.join(workingDirectory, "preview-manifest.json"), `${JSON.stringify({
      schemaVersion: "highpass.preview.v1",
      programHash: program.programHash,
      treatmentId: program.treatment.id,
      assetResolution,
      renderSize,
      htmlHash
    }, null, 2)}\n`);
    try {
      await rename(workingDirectory, outputDirectory);
    } catch {
      const existing = ShotPreviewManifestSchema.parse(JSON.parse(await readFile(previewManifestPath, "utf8")));
      if (existing.programHash !== program.programHash || existing.assetResolution !== assetResolution || existing.htmlHash !== htmlHash) throw new Error("The content-addressed preview directory contains unrelated files.");
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
  return PrepareInkRevealPreviewResultSchema.parse({ indexPath, shotProgramPath, programHash: program.programHash });
}

export async function prepareInkRevealPreview(input: PrepareInkRevealPreviewRequest) {
  const request = PrepareInkRevealPreviewRequestSchema.parse(input);
  const manifestPath = path.resolve(request.visionAssetManifestPath);
  const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const program = createInkRevealShotProgram({
    shotId: request.shotId,
    attentionTarget: request.attentionTarget,
    duration: request.duration,
    directionHash: request.directionHash,
    transitionOut: request.transitionOut,
    selectedImageId: manifest.source.selectedImageId,
    selectedImageHash: manifest.provenance.sourceHash,
    visionAssetHash: manifest.artifactHash,
    visionAssetManifestPath: manifestPath,
    saliency: manifest.complexity.saliency,
    sourceDimensions: { width: manifest.source.width, height: manifest.source.height }
  });
  return prepareProgramPreview(program, manifest, request.outputDirectory);
}

function comparisonHtml(candidates: Array<{ id: TreatmentId; indexPath: string }>, duration: number) {
  const frames = candidates.map(({ id, indexPath }) => `<article><h2>${id}</h2><iframe title="${id}" src="${pathToFileURL(indexPath).href}"></iframe></article>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Highpass Treatment Comparison</title><style>body{margin:0;background:#090b10;color:#eee;font:14px system-ui;padding:18px}header{display:flex;gap:16px;align-items:center;margin-bottom:14px}input{flex:1}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}article{background:#151922;border:1px solid #343a48;border-radius:14px;padding:10px}h2{font-size:13px;margin:0 0 8px}iframe{width:100%;aspect-ratio:16/10;border:0;border-radius:8px;background:#080a0f}@media(max-width:900px){main{grid-template-columns:1fr}}</style></head><body><header><strong>Locked Scene Time</strong><input id="time" type="range" min="0" max="${duration}" step="0.001" value="0"><output id="value">0.000</output></header><main>${frames}</main><script>const slider=document.getElementById('time'),value=document.getElementById('value');function sync(){value.textContent=Number(slider.value).toFixed(3);for(const frame of document.querySelectorAll('iframe'))frame.contentWindow.postMessage({type:'highpass-render-at',time:Number(slider.value)},'*')}slider.oninput=sync;for(const frame of document.querySelectorAll('iframe'))frame.onload=sync;</script></body></html>`;
}

export async function prepareTreatmentComparison(input: PrepareTreatmentComparisonRequest) {
  const request = PrepareTreatmentComparisonRequestSchema.parse(input);
  const manifestPath = path.resolve(request.visionAssetManifestPath);
  const manifest = VisionAssetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const common = {
    shotId: request.shotId,
    attentionTarget: request.attentionTarget,
    duration: request.duration,
    seed: request.seed,
    directionHash: request.directionHash,
    transitionOut: request.transitionOut,
    selectedImageId: manifest.source.selectedImageId,
    selectedImageHash: manifest.provenance.sourceHash,
    visionAssetHash: manifest.artifactHash,
    visionAssetManifestPath: manifestPath,
    saliency: manifest.complexity.saliency,
    sourceDimensions: { width: manifest.source.width, height: manifest.source.height }
  };
  const ids: TreatmentId[] = ["ink-reveal", "memory-focus", "etched-light"];
  const programs = assertComparableTreatments(ids.map((treatmentId) => createTreatmentShotProgram({
    ...common,
    treatmentId,
    controls: request.controls?.[treatmentId]
  })));
  for (const program of programs) assertTreatmentChannels(program, manifest);
  const previewRoot = path.join(path.resolve(request.outputDirectory), "candidates");
  const previews = await Promise.all(programs.map((program) => prepareProgramPreview(program, manifest, previewRoot, true)));
  const renderSize = { width: manifest.source.previewWidth, height: manifest.source.previewHeight, maxPixels: MAX_PREVIEW_PIXELS };
  const probeTimes = [0, request.duration * 0.25, request.duration * 0.5, request.duration * 0.75, request.duration - 0.001]
    .map((value) => Number(value.toFixed(6)));
  const comparisonHash = createHash("sha256").update(JSON.stringify({
    programHashes: programs.map(({ programHash }) => programHash),
    renderSize,
    probeTimes
  })).digest("hex");
  const outputDirectory = path.join(path.resolve(request.outputDirectory), comparisonHash);
  await mkdir(outputDirectory, { recursive: true });
  const candidates = programs.map((program, index) => ({
    treatmentId: program.treatment.id,
    programHash: program.programHash,
    narrativeIdentityHash: program.shot.narrativeIdentityHash,
    duration: program.shot.duration,
    seed: program.shot.seed,
    renderSize,
    indexPath: previews[index].indexPath,
    shotProgramPath: previews[index].shotProgramPath
  }));
  const comparisonManifestPath = path.join(outputDirectory, "comparison-manifest.json");
  const indexPath = path.join(outputDirectory, "index.html");
  await writeFile(comparisonManifestPath, `${JSON.stringify({
    schemaVersion: "highpass.treatment-comparison.v1",
    comparisonHash,
    sourceArtifactHash: manifest.artifactHash,
    probeTimes,
    controlDefinitions: TREATMENT_CONTROL_DEFINITIONS,
    candidates
  }, null, 2)}\n`);
  await writeFile(indexPath, comparisonHtml(candidates.map((candidate) => ({ id: candidate.treatmentId, indexPath: candidate.indexPath })), request.duration));
  return PrepareTreatmentComparisonResultSchema.parse({
    indexPath,
    comparisonManifestPath,
    comparisonHash,
    candidateProgramPaths: candidates.map(({ shotProgramPath }) => shotProgramPath)
  });
}
