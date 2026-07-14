import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { ShotPreviewManifestSchema } from "./preview-builder.js";
import { ShotProgramSchema } from "./shot-sampler.js";
import { TransitionAssetManifestSchema } from "./transition-compiler.js";
import { createTransitionProgram, TransitionProgramSchema } from "./transition-program.js";
import { transitionPreviewHtml } from "./transition-preview-template.js";

export const PrepareTransitionProgramRequestSchema = z.object({
  outgoingShotProgramPath: z.string().min(1),
  outgoingPreviewIndexPath: z.string().min(1),
  incomingShotProgramPath: z.string().min(1),
  incomingPreviewIndexPath: z.string().min(1),
  transitionAssetManifestPath: z.string().min(1),
  outputDirectory: z.string().min(1)
}).strict();

export const PrepareTransitionProgramResultSchema = z.object({
  indexPath: z.string(),
  transitionProgramPath: z.string(),
  previewManifestPath: z.string().optional(),
  programHash: z.string().regex(/^[a-f0-9]{64}$/),
  htmlHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  selectedMethod: z.enum(["cross-dissolve", "distance-field-wipe", "homography-dissolve", "optical-flow-dissolve", "contour-morph"])
}).strict();
export const PrepareTransitionProgramToolOutputSchema = z.object({ result: PrepareTransitionProgramResultSchema });
export type PrepareTransitionProgramRequest = z.infer<typeof PrepareTransitionProgramRequestSchema>;
export type PrepareTransitionProgramResult = z.infer<typeof PrepareTransitionProgramResultSchema>;
export type TransitionPreviewBuilder = (request: PrepareTransitionProgramRequest) => Promise<PrepareTransitionProgramResult>;

const dataUri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export const TransitionPreviewManifestSchema = z.object({
  schemaVersion: z.literal("highpass.transition-preview.v1"),
  programHash: z.string().regex(/^[a-f0-9]{64}$/),
  transitionAssetHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectedMethod: z.enum(["cross-dissolve", "distance-field-wipe", "homography-dissolve", "optical-flow-dissolve", "contour-morph"]),
  renderSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  htmlHash: z.string().regex(/^[a-f0-9]{64}$/),
  childPreviewHashes: z.object({ outgoing: z.string().regex(/^[a-f0-9]{64}$/), incoming: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
}).strict();

async function verifiedShotPreview(programPath: string, previewPath: string) {
  if (path.dirname(programPath) !== path.dirname(previewPath) || path.basename(programPath) !== "shot-program.json" || path.basename(previewPath) !== "index.html") {
    throw new Error("A Transition Program only embeds a sibling generated Shot preview.");
  }
  const manifestPath = path.join(path.dirname(previewPath), "preview-manifest.json");
  const [program, html, manifest] = await Promise.all([
    readFile(programPath, "utf8").then((value) => ShotProgramSchema.parse(JSON.parse(value))),
    readFile(previewPath),
    readFile(manifestPath, "utf8").then((value) => ShotPreviewManifestSchema.parse(JSON.parse(value)))
  ]);
  const htmlHash = sha256(html);
  if (
    manifest.programHash !== program.programHash
    || manifest.htmlHash !== htmlHash
    || path.basename(path.dirname(previewPath)) !== htmlHash
    || path.basename(path.dirname(path.dirname(previewPath))) !== program.programHash
  ) throw new Error("The embedded Shot preview failed its content binding.");
  return { program, html: html.toString("utf8"), htmlHash };
}

export async function prepareTransitionProgram(input: PrepareTransitionProgramRequest) {
  const request = PrepareTransitionProgramRequestSchema.parse(input);
  const paths = {
    outgoingProgram: path.resolve(request.outgoingShotProgramPath),
    outgoingPreview: path.resolve(request.outgoingPreviewIndexPath),
    incomingProgram: path.resolve(request.incomingShotProgramPath),
    incomingPreview: path.resolve(request.incomingPreviewIndexPath),
    asset: path.resolve(request.transitionAssetManifestPath)
  };
  const [outgoingPreview, incomingPreview, asset] = await Promise.all([
    verifiedShotPreview(paths.outgoingProgram, paths.outgoingPreview),
    verifiedShotPreview(paths.incomingProgram, paths.incomingPreview),
    readFile(paths.asset, "utf8").then((value) => TransitionAssetManifestSchema.parse(JSON.parse(value))),
  ]);
  const program = createTransitionProgram({
    outgoingProgram: outgoingPreview.program, outgoingProgramPath: paths.outgoingProgram,
    incomingProgram: incomingPreview.program, incomingProgramPath: paths.incomingProgram,
    transitionAsset: asset, transitionAssetManifestPath: paths.asset
  });
  const renderSize = {
    width: Math.min(1280, Math.max(1, Math.round(asset.analysis.width))),
    height: Math.min(720, Math.max(1, Math.round(asset.analysis.height)))
  };
  const [runtimeSource, flowForward, flowBackward, confidenceForward, confidenceBackward, occlusionForward, occlusionBackward, distanceField] = await Promise.all([
    readFile(path.join(process.cwd(), "runtime", "transition-sampler-runtime.js"), "utf8"),
    readFile(asset.artifacts.flowForwardPath),
    readFile(asset.artifacts.flowBackwardPath),
    readFile(asset.artifacts.confidenceForwardPath),
    readFile(asset.artifacts.confidenceBackwardPath),
    readFile(asset.artifacts.occlusionForwardPath),
    readFile(asset.artifacts.occlusionBackwardPath),
    readFile(asset.sources.outgoing.distanceFieldPath)
  ]);
  const html = transitionPreviewHtml({
    program,
    asset,
    outgoingPreviewHtml: outgoingPreview.html,
    incomingPreviewHtml: incomingPreview.html,
    images: {
      flowForward: dataUri(flowForward), flowBackward: dataUri(flowBackward),
      confidenceForward: dataUri(confidenceForward), confidenceBackward: dataUri(confidenceBackward),
      occlusionForward: dataUri(occlusionForward), occlusionBackward: dataUri(occlusionBackward),
      distanceField: dataUri(distanceField)
    },
    renderSize
  }, runtimeSource);
  const rasterBindings = [
    [flowForward, asset.artifacts.flowForwardHash], [flowBackward, asset.artifacts.flowBackwardHash],
    [confidenceForward, asset.artifacts.confidenceForwardHash], [confidenceBackward, asset.artifacts.confidenceBackwardHash],
    [occlusionForward, asset.artifacts.occlusionForwardHash], [occlusionBackward, asset.artifacts.occlusionBackwardHash]
  ] as const;
  if (rasterBindings.some(([bytes, expected]) => sha256(bytes) !== expected)) throw new Error("A Transition Asset raster failed its recorded content hash.");
  const htmlHash = sha256(html);
  const outputRoot = path.resolve(request.outputDirectory);
  const outputDirectory = path.join(outputRoot, program.programHash, htmlHash);
  const indexPath = path.join(outputDirectory, "index.html");
  const transitionProgramPath = path.join(outputDirectory, "transition-program.json");
  const manifestPath = path.join(outputDirectory, "preview-manifest.json");
  try {
    const [existing, cachedHtml, cachedProgram] = await Promise.all([
      readFile(manifestPath, "utf8").then((value) => TransitionPreviewManifestSchema.parse(JSON.parse(value))),
      readFile(indexPath),
      readFile(transitionProgramPath, "utf8").then((value) => TransitionProgramSchema.parse(JSON.parse(value)))
    ]);
    if (existing.programHash !== program.programHash || existing.htmlHash !== htmlHash || sha256(cachedHtml) !== htmlHash || cachedProgram.programHash !== program.programHash || existing.childPreviewHashes.outgoing !== outgoingPreview.htmlHash || existing.childPreviewHashes.incoming !== incomingPreview.htmlHash) throw new Error("transition preview ownership mismatch");
    return PrepareTransitionProgramResultSchema.parse({ indexPath, transitionProgramPath, previewManifestPath: manifestPath, programHash: program.programHash, htmlHash, selectedMethod: program.method });
  } catch {
    // Create the absent content-addressed preview below.
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const working = path.join(outputRoot, `.${program.programHash}.${randomUUID()}`);
  await mkdir(working);
  try {
    await Promise.all([
      writeFile(path.join(working, "index.html"), html),
      writeFile(path.join(working, "transition-program.json"), `${JSON.stringify(TransitionProgramSchema.parse(program), null, 2)}\n`),
      writeFile(path.join(working, "preview-manifest.json"), `${JSON.stringify({
        schemaVersion: "highpass.transition-preview.v1",
        programHash: program.programHash,
        transitionAssetHash: asset.artifactHash,
        selectedMethod: program.method,
        renderSize,
        htmlHash,
        childPreviewHashes: { outgoing: outgoingPreview.htmlHash, incoming: incomingPreview.htmlHash }
      }, null, 2)}\n`)
    ]);
    await rename(working, outputDirectory);
  } finally {
    await rm(working, { recursive: true, force: true });
  }
  return PrepareTransitionProgramResultSchema.parse({ indexPath, transitionProgramPath, previewManifestPath: manifestPath, programHash: program.programHash, htmlHash, selectedMethod: program.method });
}
