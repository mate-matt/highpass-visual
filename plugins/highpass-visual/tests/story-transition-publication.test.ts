import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { compileDirectorProjectFile, DirectorProjectSchema } from "../src/director-compiler.js";
import { prepareTreatmentComparison } from "../src/preview-builder.js";
import { DEFAULT_BROWSER_COMMANDS, resolveLocalExecutable } from "../src/runtime-inspection.js";
import { ShotProgramSchema } from "../src/shot-sampler.js";
import { publishStory, StoryQualityEvidenceSchema, verifyStoryDelivery } from "../src/story-publication.js";
import { compileTransitionAsset } from "../src/transition-compiler.js";
import { prepareTransitionProgram } from "../src/transition-preview-builder.js";
import { compileVisionAsset } from "../src/vision-compiler.js";

const browserPath = DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));

function storyImage(shiftX: number, width = 96, height = 64) {
  const pixels = Buffer.alloc(width * height * 3, 225);
  for (let y = 10; y < height - 10; y += 1) {
    for (let x = 14; x < width - 14; x += 1) {
      const px = x + shiftX;
      if (px < 0 || px >= width) continue;
      const offset = (y * width + px) * 3;
      const checker = (Math.floor(x / 7) + Math.floor(y / 9)) % 2 === 0;
      pixels[offset] = checker ? 27 : 91;
      pixels[offset + 1] = checker ? 58 : 112;
      pixels[offset + 2] = checker ? 104 : 153;
    }
  }
  for (let index = 0; index < 14; index += 1) {
    const px = 16 + ((index * 19) % 61) + shiftX;
    const py = 12 + ((index * 23) % 39);
    if (px < 0 || px >= width) continue;
    const offset = (py * width + px) * 3;
    pixels[offset] = 224;
    pixels[offset + 1] = 116;
    pixels[offset + 2] = 43;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe("overlap-aware Story Transition publication", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-story-transition-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("replaces both adjacent overlap ranges with one true two-Shot cross dissolve", async () => {
    expect(browserPath, "A supported Chromium browser is required for transition publication validation.").toBeDefined();
    const templatePath = path.resolve("examples/director/the-signal/director-draft.json");
    const draft = JSON.parse(await readFile(templatePath, "utf8"));
    draft.projectId = "the-signal-overlap-test";
    draft.brief.targetDuration = 19.5;
    draft.shots[0].transitionOut = {
      intent: "continuity",
      duration: 0.5,
      lockedMethod: "cross-dissolve",
      reason: "Blend both live Shot renderers across one shared story-time overlap."
    };

    const sourcePaths: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const bytes = storyImage(index * 3);
      const sourcePath = path.join(root, `source-${index}.ppm`);
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(sourcePath, bytes);
      sourcePaths.push(sourcePath);
      draft.imageCandidates[index].path = sourcePath;
      draft.imageCandidates[index].contentHash = contentHash;
      draft.imageCandidates[index].width = 96;
      draft.imageCandidates[index].height = 64;
      draft.imageCandidates[index].origin.sourcePath = sourcePath;
      draft.selections[index].selectedImage.path = sourcePath;
      draft.selections[index].selectedImage.contentHash = contentHash;
      draft.shotProgramPlans[index].selectedImageHash = contentHash;
    }
    const draftPath = path.join(root, "director-draft.json");
    await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
    const directed = await compileDirectorProjectFile({ draftPath, outputRoot: path.join(root, "director") });
    const project = DirectorProjectSchema.parse(JSON.parse(await readFile(directed.projectPath, "utf8")));

    const shots: Array<{ shotId: string; shotProgramPath: string; previewIndexPath: string }> = [];
    const visionManifestPaths: string[] = [];
    for (let index = 0; index < project.shots.length; index += 1) {
      const shot = project.shots[index];
      const selection = project.selections.find(({ shotId }) => shotId === shot.id)!;
      const plan = project.shotProgramPlans.find(({ shotId }) => shotId === shot.id)!;
      const vision = await compileVisionAsset({
        selectedImage: { id: selection.selectedImage.id, path: sourcePaths[index], contentHash: selection.selectedImage.contentHash },
        recipe: plan.visionRecipe,
        artifactRoot: path.join(root, "vision", shot.id)
      });
      visionManifestPaths.push(vision.manifestPath);
      const comparison = await prepareTreatmentComparison({
        shotId: shot.id,
        attentionTarget: shot.attentionTarget,
        duration: shot.duration,
        transitionOut: shot.transitionOut,
        directionHash: plan.directionHash,
        seed: plan.seed,
        visionAssetManifestPath: vision.manifestPath,
        outputDirectory: path.join(root, "previews", shot.id)
      });
      const matching = await Promise.all(comparison.candidateProgramPaths.map(async (candidatePath) => ({
        candidatePath,
        program: ShotProgramSchema.parse(JSON.parse(await readFile(candidatePath, "utf8")))
      })));
      const match = matching.find(({ program }) => program.treatment.id === shot.treatmentId);
      if (!match) throw new Error(`missing ${shot.treatmentId} candidate`);
      shots.push({ shotId: shot.id, shotProgramPath: match.candidatePath, previewIndexPath: path.join(path.dirname(match.candidatePath), "index.html") });
    }

    const transitionAsset = await compileTransitionAsset({
      outgoingVisionManifestPath: visionManifestPaths[0],
      incomingVisionManifestPath: visionManifestPaths[1],
      transitionIntent: project.shots[0].transitionOut,
      artifactRoot: path.join(root, "transition-assets")
    });
    const transition = await prepareTransitionProgram({
      outgoingShotProgramPath: shots[0].shotProgramPath,
      outgoingPreviewIndexPath: shots[0].previewIndexPath,
      incomingShotProgramPath: shots[1].shotProgramPath,
      incomingPreviewIndexPath: shots[1].previewIndexPath,
      transitionAssetManifestPath: transitionAsset.manifestPath,
      outputDirectory: path.join(root, "transition-previews")
    });
    expect(transition.selectedMethod).toBe("cross-dissolve");

    const request = {
      directorProjectPath: directed.projectPath,
      shots,
      transitions: [{
        outgoingShotId: shots[0].shotId,
        incomingShotId: shots[1].shotId,
        transitionProgramPath: transition.transitionProgramPath,
        previewIndexPath: transition.indexPath
      }],
      deliveryProfile: { id: "overlap-cross", width: 96, height: 64, fps: 4, codec: "h264" as const, pixelFormat: "yuv420p" as const },
      outputRoot: path.join(root, "deliveries")
    };
    const options = { browserExecutable: browserPath! };
    const first = await publishStory(request, options);
    const evidence = StoryQualityEvidenceSchema.parse(JSON.parse(await readFile(first.qualityEvidencePath, "utf8")));
    const storyFrames = JSON.parse(await readFile(evidence.frameManifestPath, "utf8")) as {
      frames: Array<{ kind: string; sourceIndex: number; sourceTime: number }>;
    };

    expect(first).toMatchObject({ status: "published", expectedFrameCount: 78 });
    expect(evidence.sceneRanges).toEqual([
      expect.objectContaining({ shotId: shots[0].shotId, start: 0, end: 10, overlapDuration: 0.5, transitionType: "cross-dissolve" }),
      expect.objectContaining({ shotId: shots[1].shotId, start: 9.5, end: 19.5, overlapDuration: 0 })
    ]);
    expect(evidence.transitions).toEqual([
      expect.objectContaining({ selectedMethod: "cross-dissolve", storyStart: 9.5, storyEnd: 10, expectedFrameCount: 2 })
    ]);
    expect(storyFrames.frames.slice(38, 40)).toEqual([
      expect.objectContaining({ kind: "transition", sourceIndex: 0, sourceTime: 0 }),
      expect.objectContaining({ kind: "transition", sourceIndex: 1, sourceTime: 0.25 })
    ]);
    expect(storyFrames.frames[37]).toMatchObject({ kind: "shot", sourceIndex: 37 });
    expect(storyFrames.frames[40]).toMatchObject({ kind: "shot", sourceIndex: 2 });
    expect((await verifyStoryDelivery(first.qualityEvidencePath)).storyHash).toBe(first.storyHash);

    const second = await publishStory(request, options);
    expect(second.shots.every(({ renderedFrames, reusedFrames }) => renderedFrames === 0 && reusedFrames === 40)).toBe(true);
    expect(second.transitions[0]).toMatchObject({ renderedFrames: 0, reusedFrames: 2 });
    const transitionFrameBytes = await readFile(evidence.transitions[0].frameManifestPath, "utf8");
    const corruptedTransitionFrames = JSON.parse(transitionFrameBytes);
    corruptedTransitionFrames.frames[0].outgoingSceneTime += 0.001;
    await writeFile(evidence.transitions[0].frameManifestPath, `${JSON.stringify(corruptedTransitionFrames, null, 2)}\n`);
    await expect(verifyStoryDelivery(first.qualityEvidencePath)).rejects.toThrow(/sampled Program state/i);
  }, 180_000);
});
