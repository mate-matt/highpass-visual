import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { compileDirectorProjectFile, DirectorProjectSchema } from "../src/director-compiler.js";
import { prepareTreatmentComparison } from "../src/preview-builder.js";
import { DEFAULT_BROWSER_COMMANDS, createSystemCommandProbe, resolveLocalExecutable } from "../src/runtime-inspection.js";
import { ShotProgramSchema } from "../src/shot-sampler.js";
import {
  StoryQualityEvidenceSchema,
  publishStory,
  verifyStoryDelivery
} from "../src/story-publication.js";
import { compileVisionAsset } from "../src/vision-compiler.js";

const browserPath = DEFAULT_BROWSER_COMMANDS.map(resolveLocalExecutable).find((candidate): candidate is string => Boolean(candidate));

describe("multi-Shot Story Publication", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "highpass-story-publication-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("publishes Beat-ordered Shots with transitions, audio, subtitles, reframing, and local repair", async () => {
    expect(browserPath, "A supported Chromium browser is required for story publication validation.").toBeDefined();
    const exampleDirectory = path.resolve("examples/director/the-signal");
    const directed = await compileDirectorProjectFile({
      draftPath: path.join(exampleDirectory, "director-draft.json"),
      outputRoot: path.join(root, "director")
    });
    const project = DirectorProjectSchema.parse(JSON.parse(await readFile(directed.projectPath, "utf8")));
    const shotInputs: Array<{ shotId: string; shotProgramPath: string; previewIndexPath: string }> = [];
    for (const shot of project.shots) {
      const selection = project.selections.find(({ shotId }) => shotId === shot.id)!;
      const plan = project.shotProgramPlans.find(({ shotId }) => shotId === shot.id)!;
      const vision = await compileVisionAsset({
        selectedImage: {
          id: selection.selectedImage.id,
          path: selection.selectedImage.path,
          contentHash: selection.selectedImage.contentHash
        },
        recipe: plan.visionRecipe,
        artifactRoot: path.join(root, "vision", shot.id)
      });
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
      let selectedProgramPath = "";
      for (const candidatePath of comparison.candidateProgramPaths) {
        const program = ShotProgramSchema.parse(JSON.parse(await readFile(candidatePath, "utf8")));
        if (program.treatment.id === shot.treatmentId) selectedProgramPath = candidatePath;
      }
      if (!selectedProgramPath) throw new Error(`missing ${shot.treatmentId} candidate`);
      shotInputs.push({
        shotId: shot.id,
        shotProgramPath: selectedProgramPath,
        previewIndexPath: path.join(path.dirname(selectedProgramPath), "index.html")
      });
    }

    const probe = createSystemCommandProbe({ timeoutMs: 180_000, maxOutputBytes: 65_536 });
    const audioPath = path.join(root, "existing-audio.wav");
    const audio = await probe.run("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=20",
      "-c:a", "pcm_s16le", audioPath
    ]);
    expect(audio.ok).toBe(true);
    const subtitlePath = path.join(root, "existing-subtitles.srt");
    await writeFile(subtitlePath, "1\n00:00:01,000 --> 00:00:05,000\nMira leaves the harbor.\n\n2\n00:00:12,000 --> 00:00:18,000\nThe signal returns.\n\n3\n00:00:19,000 --> 00:00:25,000\nThis cue must be clipped.\n");

    const landscapeRequest = {
      directorProjectPath: directed.projectPath,
      shots: shotInputs,
      deliveryProfile: { id: "story-landscape", width: 32, height: 16, fps: 1, codec: "h264" as const, pixelFormat: "yuv420p" as const },
      audioPath,
      subtitlePath,
      outputRoot: path.join(root, "story-deliveries")
    };
    const options = { browserExecutable: browserPath! };
    const first = await publishStory(landscapeRequest, options);
    const evidence = StoryQualityEvidenceSchema.parse(JSON.parse(await readFile(first.qualityEvidencePath, "utf8")));
    expect(first).toMatchObject({ status: "published", expectedFrameCount: 20 });
    expect(evidence.sceneRanges).toEqual([
      expect.objectContaining({ shotId: "shot-leave", start: 0, end: 10, transitionIntent: "atmospheric", transitionType: "fade-to-black" }),
      expect.objectContaining({ shotId: "shot-light", start: 10, end: 20, transitionIntent: "terminal", transitionType: "cut" })
    ]);
    expect(evidence.media).toMatchObject({ frameCount: 20, duration: 20, containerDuration: 20, width: 32, height: 16, audioPresent: true, subtitlePresent: true });
    expect(evidence.shots.map(({ treatmentId }) => treatmentId)).toEqual(["memory-focus", "etched-light"]);
    expect(evidence.shots.every(({ observationHold }) => observationHold >= 2)).toBe(true);
    expect(evidence.shots.every(({ complexity }) => complexity.pathWithinBudget && complexity.verticesWithinBudget)).toBe(true);
    expect((await verifyStoryDelivery(first.qualityEvidencePath)).storyHash).toBe(first.storyHash);

    const evidenceText = await readFile(first.qualityEvidencePath, "utf8");
    const tamperedEvidence = JSON.parse(evidenceText) as typeof evidence;
    tamperedEvidence.sceneRanges[1].start = 9;
    await writeFile(first.qualityEvidencePath, `${JSON.stringify(tamperedEvidence, null, 2)}\n`);
    await expect(verifyStoryDelivery(first.qualityEvidencePath)).rejects.toMatchObject({ code: "STORY_QUALITY_EVIDENCE_MISMATCH" });
    await writeFile(first.qualityEvidencePath, evidenceText);

    const tamperedOpenCvEvidence = JSON.parse(evidenceText) as typeof evidence;
    tamperedOpenCvEvidence.shots[0].warnings.push("invented warning");
    await writeFile(first.qualityEvidencePath, `${JSON.stringify(tamperedOpenCvEvidence, null, 2)}\n`);
    await expect(verifyStoryDelivery(first.qualityEvidencePath)).rejects.toMatchObject({ code: "STORY_QUALITY_EVIDENCE_MISMATCH" });
    await writeFile(first.qualityEvidencePath, evidenceText);

    const secondShotManifest = JSON.parse(await readFile(first.shots[1].frameManifestPath, "utf8")) as { frames: Array<{ path: string }> };
    await writeFile(secondShotManifest.frames[4].path, "corrupted shot frame");
    const repaired = await publishStory(landscapeRequest, options);
    expect(repaired.shots[0]).toMatchObject({ renderedFrames: 0, reusedFrames: 10 });
    expect(repaired.shots[1]).toMatchObject({ renderedFrames: 1, reusedFrames: 9 });

    const portrait = await publishStory({
      ...landscapeRequest,
      audioPath: undefined,
      subtitlePath: undefined,
      deliveryProfile: { ...landscapeRequest.deliveryProfile, id: "story-portrait", width: 16, height: 32 }
    }, options);
    const portraitEvidence = StoryQualityEvidenceSchema.parse(JSON.parse(await readFile(portrait.qualityEvidencePath, "utf8")));
    expect(portraitEvidence.sceneRanges.map(({ shotId }) => shotId)).toEqual(["shot-leave", "shot-light"]);
    expect(portraitEvidence.media).toMatchObject({ width: 16, height: 32, frameCount: 20, audioPresent: false, subtitlePresent: false });
    expect(portraitEvidence.shots.map(({ selectedFrames }) => selectedFrames.map(({ sceneTime, stateHash }) => ({ sceneTime, stateHash })))).toEqual(
      evidence.shots.map(({ selectedFrames }) => selectedFrames.map(({ sceneTime, stateHash }) => ({ sceneTime, stateHash })))
    );
  }, 180_000);
});
