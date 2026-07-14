import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { VisionRecipeSchema } from "./vision-compiler.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HashSchema = z.string().regex(HASH_PATTERN);
const IdSchema = z.string().min(1).max(160);
const TreatmentIdSchema = z.enum(["ink-reveal", "memory-focus", "etched-light"]);

const EntitySchema = z.object({ id: IdSchema, name: z.string().min(1), visualIdentity: z.string().min(8) }).strict();
const CandidateOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import"), sourcePath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("codex-imagegen"), generationId: z.string().min(1), promptHash: HashSchema }).strict()
]);
export const TransitionMethodSchema = z.enum([
  "cut",
  "fade-to-black",
  "cross-dissolve",
  "distance-field-wipe",
  "homography-dissolve",
  "optical-flow-dissolve",
  "contour-morph"
]);
export const TransitionIntentSchema = z.object({
  intent: z.enum(["continuity", "reveal", "atmospheric", "dislocation", "terminal"]),
  duration: z.number().min(0).max(3),
  reason: z.string().min(8),
  lockedMethod: TransitionMethodSchema.optional()
}).strict().superRefine((transition, context) => {
  const pairwise = transition.intent === "continuity" || transition.intent === "reveal" || transition.intent === "atmospheric";
  if (pairwise && transition.duration < 0.25) context.addIssue({ code: "custom", message: "A pairwise Transition Intent needs at least 0.25 seconds." });
  if (!pairwise && transition.duration !== 0) context.addIssue({ code: "custom", message: "Dislocation and terminal Transition Intents have zero duration." });
  if (transition.intent === "terminal" && transition.lockedMethod !== "cut") context.addIssue({ code: "custom", message: "A terminal Transition Intent must lock the cut method." });
  if (transition.intent === "dislocation" && transition.lockedMethod && transition.lockedMethod !== "cut") context.addIssue({ code: "custom", message: "A dislocation Transition Intent may only lock the cut method." });
  if (pairwise && transition.lockedMethod === "cut") context.addIssue({ code: "custom", message: "A pairwise Transition Intent cannot lock the cut method." });
  if (transition.lockedMethod === "fade-to-black" && transition.intent !== "atmospheric") context.addIssue({ code: "custom", message: "Fade to black is only valid for atmospheric intent." });
});
const LegacyTransitionSchema = z.object({
  type: z.enum(["cut", "fade"]),
  duration: z.number().min(0).max(3),
  reason: z.string().min(8)
}).strict().superRefine((transition, context) => {
  if (transition.type === "cut" && transition.duration !== 0) context.addIssue({ code: "custom", message: "A cut has zero duration." });
  if (transition.type === "fade" && transition.duration <= 0) context.addIssue({ code: "custom", message: "A fade needs positive duration." });
});
const DraftTransitionSchema = z.union([TransitionIntentSchema, LegacyTransitionSchema]);

const DirectorBaseSchema = z.object({
  schemaVersion: z.string(),
  projectId: IdSchema,
  sourceMaterial: z.object({
    id: IdSchema,
    title: z.string().min(1),
    text: z.string().min(1),
    language: z.string().min(2),
    contentHash: HashSchema,
    provenance: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user-input") }).strict(),
      z.object({ kind: z.literal("local-file"), sourcePath: z.string().min(1) }).strict()
    ])
  }).strict(),
  brief: z.object({
    audience: z.string().min(1),
    targetDuration: z.number().min(5).max(600),
    aspectRatio: z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/),
    mood: z.array(z.string().min(1)).min(1),
    tone: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string().min(1)),
    forbiddenTreatments: z.array(TreatmentIdSchema)
  }).strict(),
  storyModel: z.object({
    logline: z.string().min(8),
    narrativeTruths: z.array(z.object({ id: IdSchema, statement: z.string().min(8) }).strict()).min(1),
    states: z.array(z.object({ id: IdSchema, label: z.string().min(2), description: z.string().min(8) }).strict()).min(2),
    emotionalArc: z.array(z.object({ order: z.number().int().positive(), stateId: IdSchema, description: z.string().min(8) }).strict()).min(2),
    motifs: z.array(z.object({ id: IdSchema, description: z.string().min(8), entityIds: z.array(IdSchema) }).strict()),
    entities: z.object({
      characters: z.array(EntitySchema),
      places: z.array(EntitySchema),
      props: z.array(EntitySchema)
    }).strict(),
    visualBible: z.object({
      id: IdSchema,
      aspectRatio: z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/),
      paletteId: IdSchema,
      palette: z.array(z.string().regex(/^#[a-f0-9]{6}$/i)).min(2),
      stylePrinciples: z.array(z.string().min(4)).min(1)
    }).strict(),
    continuityConstraints: z.array(z.object({
      id: IdSchema,
      statement: z.string().min(8),
      entityIds: z.array(IdSchema).min(1)
    }).strict())
  }).strict(),
  beats: z.array(z.object({
    id: IdSchema,
    order: z.number().int().positive(),
    summary: z.string().min(4),
    change: z.object({ from: z.string().min(2), to: z.string().min(2) }).strict(),
    entityIds: z.array(IdSchema)
  }).strict()).min(1),
  shots: z.array(z.object({
    id: IdSchema,
    order: z.number().int().positive(),
    beatId: IdSchema,
    purpose: z.string().min(8),
    attentionTarget: z.string().min(4),
    duration: z.number().min(5).max(120),
    composition: z.string().min(4),
    imageSpecificationId: IdSchema,
    treatmentId: TreatmentIdSchema,
    transitionOut: DraftTransitionSchema
  }).strict()).min(1),
  imageSpecifications: z.array(z.object({
    id: IdSchema,
    shotId: IdSchema,
    prompt: z.string().min(8),
    visualBibleId: IdSchema,
    characterIds: z.array(IdSchema),
    placeIds: z.array(IdSchema),
    propIds: z.array(IdSchema),
    continuityConstraintIds: z.array(IdSchema)
  }).strict()).min(1),
  imageCandidates: z.array(z.object({
    id: IdSchema,
    imageSpecificationId: IdSchema,
    path: z.string().min(1),
    contentHash: HashSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    origin: CandidateOriginSchema
  }).strict()).min(1),
  selections: z.array(z.object({
    shotId: IdSchema,
    candidateId: IdSchema,
    selectedImage: z.object({ id: IdSchema, path: z.string().min(1), contentHash: HashSchema }).strict(),
    decision: z.string().min(8)
  }).strict()).min(1),
  shotProgramPlans: z.array(z.object({
    shotId: IdSchema,
    selectedImageId: IdSchema,
    selectedImageHash: HashSchema,
    treatmentId: TreatmentIdSchema,
    visionRecipe: VisionRecipeSchema,
    seed: z.string().min(1),
    directionHash: HashSchema.optional(),
    status: z.literal("awaiting-vision-asset")
  }).strict()).min(1)
}).strict();

type DirectorLike = z.infer<typeof DirectorBaseSchema>;

const CanonicalDirectorBaseSchema = DirectorBaseSchema.extend({
  shots: z.array(DirectorBaseSchema.shape.shots.element.extend({
    transitionOut: TransitionIntentSchema
  }).strict()).min(1)
}).strict();

type CanonicalDirectorLike = z.infer<typeof CanonicalDirectorBaseSchema>;

function overlapDuration(transition: z.infer<typeof DraftTransitionSchema>) {
  if (!("intent" in transition)) return 0;
  if (transition.lockedMethod === "fade-to-black" || transition.lockedMethod === "cut") return 0;
  return transition.intent === "continuity" || transition.intent === "reveal" || transition.intent === "atmospheric"
    ? transition.duration
    : 0;
}

function duplicateIds(items: Array<{ id: string }>) {
  return new Set(items.map(({ id }) => id)).size !== items.length;
}

function validateReferences(project: DirectorLike, context: z.core.$RefinementCtx) {
  const entityArrays = [project.storyModel.entities.characters, project.storyModel.entities.places, project.storyModel.entities.props];
  const characterIds = new Set(project.storyModel.entities.characters.map(({ id }) => id));
  const placeIds = new Set(project.storyModel.entities.places.map(({ id }) => id));
  const propIds = new Set(project.storyModel.entities.props.map(({ id }) => id));
  const entityIds = new Set(entityArrays.flat().map(({ id }) => id));
  const beatIds = new Set(project.beats.map(({ id }) => id));
  const specificationIds = new Set(project.imageSpecifications.map(({ id }) => id));
  const candidateIds = new Set(project.imageCandidates.map(({ id }) => id));
  const continuityIds = new Set(project.storyModel.continuityConstraints.map(({ id }) => id));
  const issue = (message: string) => context.addIssue({ code: "custom", message });

  if (createHash("sha256").update(project.sourceMaterial.text).digest("hex") !== project.sourceMaterial.contentHash) issue("Source Material content hash is stale.");
  if ([project.beats, project.shots, project.imageSpecifications, project.imageCandidates].some((items) => duplicateIds(items))) issue("Artifact identifiers must be unique within each collection.");
  if (duplicateIds(entityArrays.flat()) || duplicateIds(project.storyModel.continuityConstraints)) issue("Entity and continuity identifiers must be unique.");
  if (project.beats.some((beat, index) => beat.order !== index + 1 || beat.change.from.trim() === beat.change.to.trim())) issue("Beats must be contiguous and each must contain one meaningful change.");
  if (project.shots.some((shot, index) => shot.order !== index + 1)) issue("Shots must use contiguous story order.");
  if (project.brief.aspectRatio !== project.storyModel.visualBible.aspectRatio) issue("Brief and Visual Bible aspect ratios must match.");
  if (project.shots.some((shot) => project.brief.forbiddenTreatments.includes(shot.treatmentId))) issue("A Shot uses a Treatment forbidden by the brief.");
  const storyDuration = project.shots.reduce((sum, shot) => sum + shot.duration - overlapDuration(shot.transitionOut), 0);
  if (Math.abs(storyDuration - project.brief.targetDuration) > 1e-9) issue("Shot durations minus pairwise overlaps must equal the brief target Story Time.");
  for (const [index, shot] of project.shots.entries()) {
    const last = index === project.shots.length - 1;
    if ("intent" in shot.transitionOut) {
      if (last && shot.transitionOut.intent !== "terminal") issue("The final Shot must use terminal Transition Intent.");
      if (!last && shot.transitionOut.intent === "terminal") issue("Only the final Shot may use terminal Transition Intent.");
    } else if (last && shot.transitionOut.type !== "cut") {
      issue("The final legacy Shot transition must be a cut before canonical migration.");
    }
    const incomingOverlap = index > 0 ? overlapDuration(project.shots[index - 1].transitionOut) : 0;
    const outgoingOverlap = overlapDuration(shot.transitionOut);
    if (incomingOverlap + outgoingOverlap >= shot.duration) issue("A Shot's incoming and outgoing pairwise overlaps must sum to less than its duration.");
  }
  if (project.beats.some((beat) => !project.shots.some((shot) => shot.beatId === beat.id))) issue("Every Beat must own at least one Shot.");
  if (project.shots.some((shot) => !beatIds.has(shot.beatId))) issue("Every Shot must reference an existing Beat.");
  const beatOrder = new Map(project.beats.map((beat) => [beat.id, beat.order]));
  if (project.shots.some((shot, index) => index > 0 && (beatOrder.get(shot.beatId) ?? 0) < (beatOrder.get(project.shots[index - 1].beatId) ?? 0))) issue("Shot order cannot move backward in Beat order.");
  if (project.beats.some((beat) => beat.entityIds.some((id) => !entityIds.has(id)))) issue("Beat entity reference is broken.");
  if (project.storyModel.continuityConstraints.some((constraint) => constraint.entityIds.some((id) => !entityIds.has(id)))) issue("Continuity constraint entity reference is broken.");
  if (project.storyModel.motifs.some((motif) => motif.entityIds.some((id) => !entityIds.has(id)))) issue("Motif entity reference is broken.");
  const stateIds = new Set(project.storyModel.states.map(({ id }) => id));
  if (duplicateIds(project.storyModel.states) || project.storyModel.emotionalArc.some((entry, index) => entry.order !== index + 1 || !stateIds.has(entry.stateId))) issue("Emotional Arc must use ordered references to canonical Story states.");

  if (project.imageSpecifications.length !== project.shots.length) issue("Every Shot needs exactly one Image Specification.");
  for (const specification of project.imageSpecifications) {
    const shot = project.shots.find(({ id }) => id === specification.shotId);
    if (!shot || shot.imageSpecificationId !== specification.id) issue("Image Specification and Shot references must be reciprocal.");
    if (specification.visualBibleId !== project.storyModel.visualBible.id) issue("Every Image Specification must bind the shared Visual Bible.");
    if (specification.characterIds.some((id) => !characterIds.has(id))) issue("Image Specification character reference is broken or mistyped.");
    if (specification.placeIds.some((id) => !placeIds.has(id))) issue("Image Specification place reference is broken or mistyped.");
    if (specification.propIds.some((id) => !propIds.has(id))) issue("Image Specification prop reference is broken or mistyped.");
    if (specification.continuityConstraintIds.some((id) => !continuityIds.has(id))) issue("Image Specification continuity reference is broken.");
  }
  if (project.imageCandidates.some((candidate) => !specificationIds.has(candidate.imageSpecificationId))) issue("Image Candidate references a missing Image Specification.");
  for (const candidate of project.imageCandidates) {
    const specification = project.imageSpecifications.find(({ id }) => id === candidate.imageSpecificationId);
    if (candidate.origin.kind === "codex-imagegen" && specification && candidate.origin.promptHash !== createHash("sha256").update(specification.prompt).digest("hex")) issue("ImageGen candidate prompt hash is stale relative to its Image Specification.");
    if (candidate.origin.kind === "import" && path.resolve(candidate.origin.sourcePath) !== path.resolve(candidate.path)) issue("Imported candidate provenance must identify the verified candidate path.");
  }
  if (project.selections.length !== project.shots.length || new Set(project.selections.map(({ shotId }) => shotId)).size !== project.shots.length) issue("Every Shot needs exactly one selection record.");
  if (new Set(project.selections.map(({ selectedImage }) => selectedImage.id)).size !== project.selections.length) issue("Selected Image identities must be unique.");
  for (const selection of project.selections) {
    const shot = project.shots.find(({ id }) => id === selection.shotId);
    const candidate = project.imageCandidates.find(({ id }) => id === selection.candidateId);
    if (!shot || !candidate || !candidateIds.has(selection.candidateId)) {
      issue("Selection references a missing Shot or Image Candidate.");
      continue;
    }
    if (candidate.imageSpecificationId !== shot.imageSpecificationId) issue("Selected candidate belongs to another Shot.");
    if (selection.selectedImage.path !== candidate.path || selection.selectedImage.contentHash !== candidate.contentHash) issue("Selected Image does not match the accepted candidate bytes.");
  }
  if (project.shotProgramPlans.length !== project.shots.length || new Set(project.shotProgramPlans.map(({ shotId }) => shotId)).size !== project.shots.length) issue("Every Shot needs exactly one Shot Program plan.");
  for (const plan of project.shotProgramPlans) {
    const shot = project.shots.find(({ id }) => id === plan.shotId);
    const selection = project.selections.find(({ shotId }) => shotId === plan.shotId);
    if (!shot || !selection) {
      issue("Shot Program plan reference is broken.");
      continue;
    }
    if (plan.treatmentId !== shot.treatmentId || plan.selectedImageId !== selection.selectedImage.id || plan.selectedImageHash !== selection.selectedImage.contentHash) issue("Shot Program plan is stale relative to direction or selection.");
    if (plan.directionHash !== undefined && plan.directionHash !== shotDirectionHash(project, plan.shotId)) issue("Shot Program plan direction hash is stale relative to the Story Model or directed Shot.");
  }
}

export const DirectorProjectDraftSchema = DirectorBaseSchema.extend({
  schemaVersion: z.literal("highpass.director-project-draft.v1")
}).superRefine(validateReferences);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}

function stableStringify(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function shotDirectionHash(project: DirectorLike | CanonicalDirectorLike, shotId: string) {
  const shot = project.shots.find(({ id }) => id === shotId);
  const beat = shot ? project.beats.find(({ id }) => id === shot.beatId) : undefined;
  const imageSpecification = project.imageSpecifications.find(({ shotId: owner }) => owner === shotId);
  const selection = project.selections.find(({ shotId: owner }) => owner === shotId);
  const plan = project.shotProgramPlans.find(({ shotId: owner }) => owner === shotId);
  if (!shot || !beat || !imageSpecification || !selection || !plan) {
    throw new DirectorCompilerError("DIRECTION_HASH_INPUT_INVALID", `Shot ${shotId} does not have complete direction dependencies.`);
  }
  const { directionHash: _ignored, ...planInput } = plan;
  return createHash("sha256").update(stableStringify({
    sourceMaterialHash: project.sourceMaterial.contentHash,
    brief: project.brief,
    storyModel: project.storyModel,
    beat,
    shot,
    imageSpecification,
    selection,
    plan: planInput
  })).digest("hex");
}

function directorContentHash(project: DirectorLike & { directorHash?: string }) {
  const { directorHash: _ignored, ...content } = project;
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export const DirectorProjectSchema = CanonicalDirectorBaseSchema.extend({
  schemaVersion: z.literal("highpass.director-project.v1"),
  directorHash: HashSchema
}).superRefine((project, context) => {
  validateReferences(project, context);
  for (const plan of project.shotProgramPlans) {
    if (!plan.directionHash || plan.directionHash !== shotDirectionHash(project, plan.shotId)) {
      context.addIssue({ code: "custom", message: `Shot Program plan ${plan.shotId} is missing its compiled direction hash.` });
    }
  }
  if (project.directorHash !== directorContentHash(project)) context.addIssue({ code: "custom", message: "Director Project hash does not match its content." });
});

export const CompileDirectorProjectRequestSchema = z.object({ draftPath: z.string().min(1), outputRoot: z.string().min(1) });
export const CompileDirectorProjectResultSchema = z.object({
  projectPath: z.string(),
  directorHash: HashSchema,
  cache: z.enum(["hit", "miss"])
});
export const CompileDirectorProjectToolOutputSchema = z.object({ result: CompileDirectorProjectResultSchema });
export type DirectorProjectDraft = z.infer<typeof DirectorProjectDraftSchema>;
export type CompileDirectorProjectResult = z.infer<typeof CompileDirectorProjectResultSchema>;
export type DirectorCompiler = (request: z.infer<typeof CompileDirectorProjectRequestSchema>) => Promise<CompileDirectorProjectResult>;

export class DirectorCompilerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DirectorCompilerError";
  }
}

async function fileHash(target: string) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : null;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireDirectorLock(lockPath: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return async () => rm(lockPath, { recursive: true, force: true });
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
      await delay(30);
    }
  }
  throw new DirectorCompilerError("DIRECTOR_CACHE_LOCK_TIMEOUT", "Another Director Project compilation held the cache lock for too long.");
}

function normalizeDraftPaths(input: unknown, baseDirectory: string) {
  const draft = structuredClone(input) as Record<string, any>;
  if (draft.sourceMaterial?.provenance?.kind === "local-file") {
    draft.sourceMaterial.provenance.sourcePath = path.resolve(baseDirectory, draft.sourceMaterial.provenance.sourcePath);
  }
  for (const candidate of draft.imageCandidates ?? []) {
    candidate.path = path.resolve(baseDirectory, candidate.path);
    if (candidate.origin?.kind === "import") candidate.origin.sourcePath = path.resolve(baseDirectory, candidate.origin.sourcePath);
  }
  for (const selection of draft.selections ?? []) {
    if (selection.selectedImage?.path) selection.selectedImage.path = path.resolve(baseDirectory, selection.selectedImage.path);
  }
  return draft;
}

function normalizeTransitions(draft: DirectorLike): CanonicalDirectorLike {
  return CanonicalDirectorBaseSchema.parse({
    ...draft,
    shots: draft.shots.map((shot, index) => {
      if ("intent" in shot.transitionOut) return shot;
      const last = index === draft.shots.length - 1;
      return {
        ...shot,
        transitionOut: shot.transitionOut.type === "fade"
          ? {
              intent: "atmospheric" as const,
              duration: shot.transitionOut.duration,
              reason: shot.transitionOut.reason,
              lockedMethod: "fade-to-black" as const
            }
          : {
              intent: last ? "terminal" as const : "dislocation" as const,
              duration: 0,
              reason: shot.transitionOut.reason,
              lockedMethod: "cut" as const
            }
      };
    })
  });
}

export async function compileDirectorProject(input: { draft: unknown; outputRoot: string; baseDirectory?: string }) {
  const draft = DirectorProjectDraftSchema.parse(normalizeDraftPaths(input.draft, path.resolve(input.baseDirectory ?? process.cwd())));
  if (draft.sourceMaterial.provenance.kind === "local-file") {
    try {
      if (await fileHash(draft.sourceMaterial.provenance.sourcePath) !== draft.sourceMaterial.contentHash) {
        throw new DirectorCompilerError("STALE_SOURCE_MATERIAL", "The local Source Material changed after its content hash was recorded.");
      }
    } catch (error) {
      if (error instanceof DirectorCompilerError) throw error;
      throw new DirectorCompilerError("SOURCE_MATERIAL_UNREADABLE", "The local Source Material is unavailable.");
    }
  }
  for (const candidate of draft.imageCandidates) {
    try {
      if (await fileHash(path.resolve(candidate.path)) !== candidate.contentHash) {
        throw new DirectorCompilerError("STALE_IMAGE_CANDIDATE", `Image Candidate ${candidate.id} changed after acceptance.`);
      }
    } catch (error) {
      if (error instanceof DirectorCompilerError) throw error;
      throw new DirectorCompilerError("IMAGE_CANDIDATE_UNREADABLE", `Image Candidate ${candidate.id} is unavailable.`);
    }
  }
  const canonicalDraft = normalizeTransitions(draft);
  const directedDraft = {
    ...canonicalDraft,
    shotProgramPlans: canonicalDraft.shotProgramPlans.map((plan) => ({
      ...plan,
      directionHash: shotDirectionHash(canonicalDraft, plan.shotId)
    }))
  };
  const withoutHash = { ...directedDraft, schemaVersion: "highpass.director-project.v1" as const };
  const directorHash = directorContentHash(withoutHash);
  const project = DirectorProjectSchema.parse({ ...withoutHash, directorHash });
  const outputRoot = path.resolve(input.outputRoot);
  const outputDirectory = path.join(outputRoot, directorHash);
  const projectPath = path.join(outputDirectory, "director-project.json");
  try {
    const existing = DirectorProjectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")));
    if (existing.directorHash === directorHash) return CompileDirectorProjectResultSchema.parse({ projectPath, directorHash, cache: "hit" });
  } catch {
    // Create the absent content-addressed artifact below.
  }
  await mkdir(outputRoot, { recursive: true });
  const releaseLock = await acquireDirectorLock(`${outputDirectory}.lock`);
  try {
    try {
      const existing = DirectorProjectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")));
      if (existing.directorHash === directorHash) return CompileDirectorProjectResultSchema.parse({ projectPath, directorHash, cache: "hit" });
    } catch {
      const quarantinePath = `${outputDirectory}.invalid.${randomUUID()}`;
      try {
        await rename(outputDirectory, quarantinePath);
        await rm(quarantinePath, { recursive: true, force: true });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  const workingDirectory = path.join(outputRoot, `.${directorHash}.${randomUUID()}`);
  await mkdir(workingDirectory);
  try {
    await writeFile(path.join(workingDirectory, "director-project.json"), `${JSON.stringify(project, null, 2)}\n`);
    try {
      await rename(workingDirectory, outputDirectory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
      const winner = DirectorProjectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")));
      if (winner.directorHash !== directorHash) throw new DirectorCompilerError("DIRECTOR_CACHE_CONFLICT", "The content-addressed Director cache contains a foreign artifact.");
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
  return CompileDirectorProjectResultSchema.parse({ projectPath, directorHash, cache: "miss" });
  } finally {
    await releaseLock();
  }
}

export async function compileDirectorProjectFile(request: z.infer<typeof CompileDirectorProjectRequestSchema>) {
  const parsed = CompileDirectorProjectRequestSchema.parse(request);
  const draftPath = path.resolve(parsed.draftPath);
  let draft: unknown;
  try {
    draft = JSON.parse(await readFile(draftPath, "utf8"));
  } catch (error) {
    throw new DirectorCompilerError(
      error instanceof SyntaxError ? "DIRECTOR_DRAFT_JSON_INVALID" : "DIRECTOR_DRAFT_UNREADABLE",
      error instanceof SyntaxError ? "The Director Project draft is not valid JSON." : "The Director Project draft could not be read."
    );
  }
  return compileDirectorProject({ draft, outputRoot: parsed.outputRoot, baseDirectory: path.dirname(draftPath) });
}
