import { createHash } from "node:crypto";
import * as z from "zod/v4";

import { sampleTransitionProgramRuntime, stableTransitionStringify } from "../runtime/transition-sampler-runtime.js";
import { TransitionMethodSchema } from "./director-compiler.js";
import { ShotProgramSchema, type ShotProgram } from "./shot-sampler.js";
import { TransitionAssetManifestSchema, type CompileTransitionAssetResult } from "./transition-compiler.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const TransitionProgramSchema = z.object({
  schemaVersion: z.literal("highpass.transition-program.v1"),
  programHash: z.string().regex(HASH_PATTERN),
  duration: z.number().min(0.25).max(3),
  method: TransitionMethodSchema,
  transitionIntent: z.object({
    intent: z.enum(["continuity", "reveal", "atmospheric", "dislocation", "terminal"]),
    duration: z.number(),
    reason: z.string(),
    lockedMethod: TransitionMethodSchema.optional()
  }).strict(),
  outgoing: z.object({
    shotId: z.string(),
    programHash: z.string().regex(HASH_PATTERN),
    programPath: z.string(),
    visionArtifactHash: z.string().regex(HASH_PATTERN),
    localStart: z.number().nonnegative(),
    localEnd: z.number().positive()
  }).strict(),
  incoming: z.object({
    shotId: z.string(),
    programHash: z.string().regex(HASH_PATTERN),
    programPath: z.string(),
    visionArtifactHash: z.string().regex(HASH_PATTERN),
    localStart: z.literal(0),
    localEnd: z.number().positive()
  }).strict(),
  transitionAsset: z.object({
    artifactHash: z.string().regex(HASH_PATTERN),
    manifestPath: z.string()
  }).strict()
}).strict().superRefine((program, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (program.method === "cut" || program.method === "fade-to-black") issue("A pairwise Transition Program needs a pairwise method.");
  if (program.duration !== program.transitionIntent.duration) issue("Transition Program duration must match its Director intent.");
  if (program.outgoing.localEnd - program.outgoing.localStart !== program.duration) issue("Outgoing local Scene Time must span exactly the shared overlap.");
  if (program.incoming.localEnd !== program.duration) issue("Incoming local Scene Time must span exactly the shared overlap.");
  if (program.programHash !== transitionProgramContentHash(program)) issue("Transition Program hash does not match its bound content.");
});

export type TransitionProgram = z.infer<typeof TransitionProgramSchema>;

export const TransitionStateSchema = z.object({
  schemaVersion: z.literal("highpass.transition-state.v1"),
  programHash: z.string().regex(HASH_PATTERN),
  method: TransitionMethodSchema,
  transitionTime: z.number().nonnegative(),
  outgoingSceneTime: z.number().nonnegative(),
  incomingSceneTime: z.number().nonnegative(),
  blend: z.number().min(0).max(1),
  spatialWarp: z.number().min(0).max(1),
  reducedMotion: z.boolean(),
  stateHash: z.string().regex(/^[a-f0-9]{16}$/)
}).strict();

export type TransitionState = z.infer<typeof TransitionStateSchema>;

function transitionProgramContentHash(program: Omit<TransitionProgram, "programHash"> | TransitionProgram) {
  const { programHash: _ignored, ...content } = program as TransitionProgram;
  return createHash("sha256").update(stableTransitionStringify(content)).digest("hex");
}

export function createTransitionProgram(input: {
  outgoingProgram: ShotProgram;
  outgoingProgramPath: string;
  incomingProgram: ShotProgram;
  incomingProgramPath: string;
  transitionAsset: z.infer<typeof TransitionAssetManifestSchema>;
  transitionAssetManifestPath: string;
}) {
  const outgoing = ShotProgramSchema.parse(input.outgoingProgram);
  const incoming = ShotProgramSchema.parse(input.incomingProgram);
  const asset = TransitionAssetManifestSchema.parse(input.transitionAsset);
  if (stableTransitionStringify(outgoing.shot.transitionOut) !== stableTransitionStringify(asset.transitionIntent)) {
    throw new Error("Transition Asset intent is stale relative to the outgoing Shot Program.");
  }
  if (outgoing.visionAsset.artifactHash !== asset.sources.outgoing.visionArtifactHash || incoming.visionAsset.artifactHash !== asset.sources.incoming.visionArtifactHash) {
    throw new Error("Transition Asset sources are stale relative to the adjacent Shot Programs.");
  }
  const duration = asset.transitionIntent.duration;
  if (duration > outgoing.shot.duration || duration > incoming.shot.duration) throw new Error("Transition overlap exceeds an adjacent Shot duration.");
  const withoutHash = {
    schemaVersion: "highpass.transition-program.v1" as const,
    duration,
    method: asset.plan.selectedMethod,
    transitionIntent: asset.transitionIntent,
    outgoing: {
      shotId: outgoing.shot.id,
      programHash: outgoing.programHash,
      programPath: input.outgoingProgramPath,
      visionArtifactHash: outgoing.visionAsset.artifactHash,
      localStart: outgoing.shot.duration - duration,
      localEnd: outgoing.shot.duration
    },
    incoming: {
      shotId: incoming.shot.id,
      programHash: incoming.programHash,
      programPath: input.incomingProgramPath,
      visionArtifactHash: incoming.visionAsset.artifactHash,
      localStart: 0 as const,
      localEnd: duration
    },
    transitionAsset: { artifactHash: asset.artifactHash, manifestPath: input.transitionAssetManifestPath }
  };
  return TransitionProgramSchema.parse({ ...withoutHash, programHash: transitionProgramContentHash(withoutHash as Omit<TransitionProgram, "programHash">) });
}

export function sampleTransitionProgram(input: TransitionProgram, transitionTime: number, options: { reducedMotion?: boolean } = {}) {
  const program = TransitionProgramSchema.parse(input);
  return TransitionStateSchema.parse(sampleTransitionProgramRuntime(program, transitionTime, options.reducedMotion === true));
}
