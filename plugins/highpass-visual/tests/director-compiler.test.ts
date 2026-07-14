import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DirectorProjectDraftSchema,
  DirectorProjectSchema,
  compileDirectorProject
} from "../src/director-compiler.js";
import { DEFAULT_VISION_RECIPE } from "../src/vision-compiler.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function validDraft(root: string) {
  const firstPath = path.join(root, "candidate-1.ppm");
  const secondPath = path.join(root, "candidate-2.ppm");
  const first = "P3\n2 2\n255\n22 35 70  80 92 130  150 112 74  232 220 190\n";
  const second = "P3\n2 2\n255\n16 24 48  64 78 112  126 94 66  220 204 176\n";
  await Promise.all([writeFile(firstPath, first), writeFile(secondPath, second)]);
  const text = "At dusk, Mira leaves the safe harbor. At dawn, she lights the abandoned signal tower.";
  return {
    schemaVersion: "highpass.director-project-draft.v1" as const,
    projectId: "harbor-signal",
    sourceMaterial: {
      id: "source-1",
      title: "The Signal",
      text,
      language: "en",
      contentHash: sha256(text),
      provenance: { kind: "user-input" as const }
    },
    brief: {
      audience: "general",
      targetDuration: 20,
      aspectRatio: "16:9",
      mood: ["reflective", "hopeful"],
      tone: ["quiet", "resolute"],
      constraints: ["No dialogue cards"],
      forbiddenTreatments: []
    },
    storyModel: {
      logline: "A keeper crosses from shelter into responsibility.",
      narrativeTruths: [{ id: "truth-duty", statement: "Courage becomes visible through a chosen duty." }],
      states: [
        { id: "state-sheltered", label: "Sheltered", description: "Mira protects herself inside the safe harbor." },
        { id: "state-responsible", label: "Responsible", description: "Mira makes her duty visible to the coast." }
      ],
      emotionalArc: [
        { order: 1, stateId: "state-sheltered", description: "Hesitation still defines the opening." },
        { order: 2, stateId: "state-responsible", description: "Chosen responsibility defines the ending." }
      ],
      motifs: [{ id: "motif-light", description: "Warm light makes responsibility visible.", entityIds: ["lantern"] }],
      entities: {
        characters: [{ id: "mira", name: "Mira", visualIdentity: "adult keeper, indigo coat, brass lantern" }],
        places: [
          { id: "harbor", name: "Safe harbor", visualIdentity: "low stone quay under violet dusk" },
          { id: "tower", name: "Signal tower", visualIdentity: "weathered iron tower above pale sea" }
        ],
        props: [{ id: "lantern", name: "Brass lantern", visualIdentity: "worn brass with warm amber flame" }]
      },
      visualBible: {
        id: "bible-1",
        aspectRatio: "16:9",
        paletteId: "harbor-amber",
        palette: ["#11182e", "#596783", "#d58c52", "#eee0bd"],
        stylePrinciples: ["cinematic painterly realism", "one warm attention anchor"]
      },
      continuityConstraints: [
        { id: "continuity-mira", statement: "Mira keeps the indigo coat and carries the same lantern.", entityIds: ["mira", "lantern"] }
      ]
    },
    beats: [
      { id: "beat-leave", order: 1, summary: "Mira leaves shelter.", change: { from: "protected hesitation", to: "chosen departure" }, entityIds: ["mira", "harbor", "lantern"] },
      { id: "beat-light", order: 2, summary: "Mira restores the signal.", change: { from: "dark abandonment", to: "visible responsibility" }, entityIds: ["mira", "tower", "lantern"] }
    ],
    shots: [
      { id: "shot-leave", order: 1, beatId: "beat-leave", purpose: "Show the irreversible choice to leave safety.", attentionTarget: "Mira's amber lantern crossing the quay", duration: 10, composition: "wide lateral silhouette", imageSpecificationId: "image-spec-leave", treatmentId: "memory-focus" as const, transitionOut: { type: "fade" as const, duration: 0.5, reason: "Dusk yields to the uncertainty of night." } },
      { id: "shot-light", order: 2, beatId: "beat-light", purpose: "Resolve duty as a light others can see.", attentionTarget: "the relit signal lens", duration: 10, composition: "low-angle tower portrait", imageSpecificationId: "image-spec-light", treatmentId: "etched-light" as const, transitionOut: { type: "cut" as const, duration: 0, reason: "The story ends on the completed signal." } }
    ],
    imageSpecifications: [
      { id: "image-spec-leave", shotId: "shot-leave", prompt: "Mira crosses a violet stone harbor carrying one amber lantern.", visualBibleId: "bible-1", characterIds: ["mira"], placeIds: ["harbor"], propIds: ["lantern"], continuityConstraintIds: ["continuity-mira"] },
      { id: "image-spec-light", shotId: "shot-light", prompt: "Mira lights a weathered signal tower above a pale dawn sea.", visualBibleId: "bible-1", characterIds: ["mira"], placeIds: ["tower"], propIds: ["lantern"], continuityConstraintIds: ["continuity-mira"] }
    ],
    imageCandidates: [
      { id: "candidate-import", imageSpecificationId: "image-spec-leave", path: firstPath, contentHash: sha256(first), width: 2, height: 2, origin: { kind: "import" as const, sourcePath: firstPath } },
      { id: "candidate-imagegen", imageSpecificationId: "image-spec-light", path: secondPath, contentHash: sha256(second), width: 2, height: 2, origin: { kind: "codex-imagegen" as const, generationId: "offline-example", promptHash: sha256("Mira lights a weathered signal tower above a pale dawn sea.") } }
    ],
    selections: [
      { shotId: "shot-leave", candidateId: "candidate-import", selectedImage: { id: "selected-leave", path: firstPath, contentHash: sha256(first) }, decision: "The silhouette makes departure legible." },
      { shotId: "shot-light", candidateId: "candidate-imagegen", selectedImage: { id: "selected-light", path: secondPath, contentHash: sha256(second) }, decision: "The lens is a single strong attention target." }
    ],
    shotProgramPlans: [
      { shotId: "shot-leave", selectedImageId: "selected-leave", selectedImageHash: sha256(first), treatmentId: "memory-focus" as const, visionRecipe: DEFAULT_VISION_RECIPE, seed: "harbor-signal:1", status: "awaiting-vision-asset" as const },
      { shotId: "shot-light", selectedImageId: "selected-light", selectedImageHash: sha256(second), treatmentId: "etched-light" as const, visionRecipe: DEFAULT_VISION_RECIPE, seed: "harbor-signal:2", status: "awaiting-vision-asset" as const }
    ]
  };
}

describe("Director Compiler", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-director-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("compiles a complete, content-addressed director project with both candidate origins", async () => {
    const draft = await validDraft(root);
    const result = await compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") });
    const project = DirectorProjectSchema.parse(JSON.parse(await readFile(result.projectPath, "utf8")));
    expect(result.directorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(project.directorHash).toBe(result.directorHash);
    expect(project.beats.map(({ order }) => order)).toEqual([1, 2]);
    expect(project.shots.map(({ attentionTarget }) => attentionTarget)).toHaveLength(2);
    expect(new Set(project.imageCandidates.map(({ origin }) => origin.kind))).toEqual(new Set(["import", "codex-imagegen"]));
    expect(project.shotProgramPlans.every(({ status }) => status === "awaiting-vision-asset")).toBe(true);
    expect(project.shotProgramPlans.every(({ directionHash }) => /^[a-f0-9]{64}$/.test(directionHash ?? ""))).toBe(true);
    expect(project.shots.map(({ transitionOut }) => transitionOut)).toEqual([
      {
        intent: "atmospheric",
        duration: 0.5,
        lockedMethod: "fade-to-black",
        reason: "Dusk yields to the uncertainty of night."
      },
      {
        intent: "terminal",
        duration: 0,
        lockedMethod: "cut",
        reason: "The story ends on the completed signal."
      }
    ]);
    expect((await compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") })).cache).toBe("hit");
  });

  test("compiles pairwise Transition Intent against overlap-aware Story Time", async () => {
    const draft = await validDraft(root);
    const canonical = {
      ...draft,
      brief: { ...draft.brief, targetDuration: 19.25 },
      shots: [
        {
          ...draft.shots[0],
          transitionOut: {
            intent: "continuity" as const,
            duration: 0.75,
            reason: "Carry Mira's chosen motion into the relit tower."
          }
        },
        {
          ...draft.shots[1],
          transitionOut: {
            intent: "terminal" as const,
            duration: 0,
            lockedMethod: "cut" as const,
            reason: "The completed signal is the final held image."
          }
        }
      ]
    };
    const result = await compileDirectorProject({ draft: canonical, outputRoot: path.join(root, "canonical") });
    const project = DirectorProjectSchema.parse(JSON.parse(await readFile(result.projectPath, "utf8")));
    expect(project.brief.targetDuration).toBe(19.25);
    expect(project.shots[0].transitionOut).toEqual(canonical.shots[0].transitionOut);
    expect(project.shots[1].transitionOut).toEqual(canonical.shots[1].transitionOut);

    expect(() => DirectorProjectDraftSchema.parse({
      ...canonical,
      brief: { ...canonical.brief, targetDuration: 20 }
    })).toThrow(/Story Time/i);
    expect(() => DirectorProjectDraftSchema.parse({
      ...canonical,
      shots: [
        { ...canonical.shots[0], transitionOut: canonical.shots[1].transitionOut },
        canonical.shots[1]
      ]
    })).toThrow(/terminal/i);
  });

  test("invalidates only the direction hash for a changed Shot", async () => {
    const draft = await validDraft(root);
    const first = await compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") });
    const firstProject = DirectorProjectSchema.parse(JSON.parse(await readFile(first.projectPath, "utf8")));
    const changedDraft = {
      ...draft,
      shots: draft.shots.map((shot, index) => index === 0
        ? { ...shot, purpose: "Show Mira actively choosing responsibility over shelter." }
        : shot)
    };
    const changed = await compileDirectorProject({ draft: changedDraft, outputRoot: path.join(root, "compiled") });
    const changedProject = DirectorProjectSchema.parse(JSON.parse(await readFile(changed.projectPath, "utf8")));
    expect(changed.directorHash).not.toBe(first.directorHash);
    expect(changedProject.shotProgramPlans[0].directionHash).not.toBe(firstProject.shotProgramPlans[0].directionHash);
    expect(changedProject.shotProgramPlans[1].directionHash).toBe(firstProject.shotProgramPlans[1].directionHash);
  });

  test("rejects incoming and outgoing overlaps that consume an entire middle Shot", async () => {
    const draft = await validDraft(root);
    const middleSpec = { ...draft.imageSpecifications[1], id: "image-spec-middle", shotId: "shot-middle" };
    const middleCandidate = {
      id: "candidate-middle",
      imageSpecificationId: middleSpec.id,
      path: draft.imageCandidates[1].path,
      contentHash: draft.imageCandidates[1].contentHash,
      width: draft.imageCandidates[1].width,
      height: draft.imageCandidates[1].height,
      origin: { kind: "import" as const, sourcePath: draft.imageCandidates[1].path }
    };
    const invalid = {
      ...draft,
      brief: { ...draft.brief, targetDuration: 20 },
      shots: [
        { ...draft.shots[0], transitionOut: { intent: "continuity" as const, duration: 3, reason: "Carry the departure into the tower approach." } },
        { ...draft.shots[1], id: "shot-middle", order: 2, duration: 5, imageSpecificationId: middleSpec.id, transitionOut: { intent: "reveal" as const, duration: 2, reason: "Grow the approaching silhouette into the lit signal." } },
        { ...draft.shots[1], order: 3, transitionOut: { intent: "terminal" as const, duration: 0, lockedMethod: "cut" as const, reason: "Hold the completed signal." } }
      ],
      imageSpecifications: [draft.imageSpecifications[0], middleSpec, draft.imageSpecifications[1]],
      imageCandidates: [draft.imageCandidates[0], middleCandidate, draft.imageCandidates[1]],
      selections: [
        draft.selections[0],
        { shotId: "shot-middle", candidateId: middleCandidate.id, selectedImage: { id: "selected-middle", path: middleCandidate.path, contentHash: middleCandidate.contentHash }, decision: "The approach establishes the shared silhouette." },
        draft.selections[1]
      ],
      shotProgramPlans: [
        draft.shotProgramPlans[0],
        { ...draft.shotProgramPlans[1], shotId: "shot-middle", selectedImageId: "selected-middle", treatmentId: "memory-focus" as const, seed: "harbor-signal:middle" },
        draft.shotProgramPlans[1]
      ]
    };
    expect(() => DirectorProjectDraftSchema.parse(invalid)).toThrow(/overlaps must sum to less/i);
  });

  test("rejects broken references, ordering, stale selections, unsupported treatments, and changed files", async () => {
    const draft = await validDraft(root);
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, beats: draft.beats.map((beat, index) => ({ ...beat, order: index + 2 })) })).toThrow();
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, shots: [{ ...draft.shots[0], beatId: "missing-beat" }, draft.shots[1]] })).toThrow();
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, selections: [{ ...draft.selections[0], selectedImage: { ...draft.selections[0].selectedImage, contentHash: "0".repeat(64) } }, draft.selections[1]] })).toThrow();
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, shots: [{ ...draft.shots[0], treatmentId: "neon-noise" }, draft.shots[1]] })).toThrow();
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, imageSpecifications: [{ ...draft.imageSpecifications[0], characterIds: ["harbor"] }, draft.imageSpecifications[1]] })).toThrow(/character reference/i);
    expect(() => DirectorProjectDraftSchema.parse({ ...draft, imageCandidates: [draft.imageCandidates[0], { ...draft.imageCandidates[1], origin: { ...draft.imageCandidates[1].origin, promptHash: "0".repeat(64) } }] })).toThrow(/prompt hash/i);
    await writeFile(draft.imageCandidates[0].path, "changed after acceptance");
    await expect(compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") })).rejects.toMatchObject({ code: "STALE_IMAGE_CANDIDATE" });
  });

  test("compiles the checked-in complete example without live image generation", async () => {
    const draftPath = path.resolve("examples/director/the-signal/director-draft.json");
    const draft = JSON.parse(await readFile(draftPath, "utf8"));
    const result = await compileDirectorProject({ draft, outputRoot: path.join(root, "example-output"), baseDirectory: path.dirname(draftPath) });
    const project = DirectorProjectSchema.parse(JSON.parse(await readFile(result.projectPath, "utf8")));
    expect(project.imageCandidates).toHaveLength(2);
    expect(project.imageCandidates[0].origin.kind).toBe("import");
    expect(project.imageCandidates[0].path).toBe(path.join(path.dirname(draftPath), "candidate.ppm"));
    expect(project.shotProgramPlans.map(({ treatmentId }) => treatmentId)).toEqual(["memory-focus", "etched-light"]);
  });

  test("quarantines a corrupt cached project and rebuilds it", async () => {
    const draft = await validDraft(root);
    const first = await compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") });
    await writeFile(first.projectPath, "truncated");
    const rebuilt = await compileDirectorProject({ draft, outputRoot: path.join(root, "compiled") });
    expect(rebuilt.cache).toBe("miss");
    const parsed = DirectorProjectSchema.parse(JSON.parse(await readFile(rebuilt.projectPath, "utf8")));
    expect(parsed.directorHash).toBe(first.directorHash);
  });
});
