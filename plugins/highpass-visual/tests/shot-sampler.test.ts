import { describe, expect, test } from "vitest";

import {
  ShotProgramSchema,
  createInkRevealShotProgram,
  sampleShotProgram
} from "../src/shot-sampler.js";

function program() {
  return createInkRevealShotProgram({
    shotId: "shot-01",
    attentionTarget: "the protagonist's face",
    duration: 10,
    selectedImageId: "selected-01",
    selectedImageHash: "a".repeat(64),
    visionAssetHash: "b".repeat(64),
    visionAssetManifestPath: "/tmp/vision/manifest.json",
    saliency: {
      centroid: { x: 0.78, y: 0.32 },
      bounds: { x: 0.64, y: 0.18, width: 0.28, height: 0.34 }
    },
    sourceDimensions: { width: 1600, height: 900 }
  });
}

describe("Shot Sampler", () => {
  test("samples exact phase boundaries from absolute Scene Time", () => {
    const shot = program();
    expect(shot.phases).toEqual([
      { id: "atmosphere", start: 0, end: 1.5 },
      { id: "outline", start: 1.5, end: 4 },
      { id: "inward-reveal", start: 4, end: 7 },
      { id: "settle", start: 7, end: 8 },
      { id: "observation", start: 8, end: 10 }
    ]);
    expect(sampleShotProgram(shot, 0).activePhase).toBe("atmosphere");
    expect(sampleShotProgram(shot, 1.5).activePhase).toBe("outline");
    expect(sampleShotProgram(shot, 4).activePhase).toBe("inward-reveal");
    expect(sampleShotProgram(shot, 7).activePhase).toBe("settle");
    expect(sampleShotProgram(shot, 8).activePhase).toBe("observation");
    expect(sampleShotProgram(shot, 10).activePhase).toBe("observation");
  });

  test("compiles a directed fade into deterministic Shot Program state after observation", () => {
    const shot = createInkRevealShotProgram({
      shotId: "shot-fade",
      attentionTarget: "the signal lamp",
      duration: 10,
      transitionOut: { intent: "atmospheric", duration: 0.5, lockedMethod: "fade-to-black", reason: "Let the returning signal fall into darkness." },
      selectedImageId: "selected-01",
      selectedImageHash: "a".repeat(64),
      visionAssetHash: "b".repeat(64),
      visionAssetManifestPath: "/tmp/vision/manifest.json"
    });
    expect(shot.phases.at(-1)).toEqual({ id: "observation", start: 7.5, end: 9.5 });
    expect(sampleShotProgram(shot, 9.49)).toMatchObject({ activePhase: "observation", layers: { transitionOpacity: 1 } });
    expect(sampleShotProgram(shot, 9.75)).toMatchObject({ activePhase: "transition", layers: { transitionOpacity: 0.5 } });
    expect(sampleShotProgram(shot, 10)).toMatchObject({ activePhase: "transition", layers: { transitionOpacity: 0 } });
  });

  test("seeking in arbitrary order returns the same complete state and hash", () => {
    const shot = program();
    const direct = sampleShotProgram(shot, 5.375);
    sampleShotProgram(shot, 9.2);
    sampleShotProgram(shot, 0.4);
    const sought = sampleShotProgram(shot, 5.375);

    expect(sought).toEqual(direct);
    expect(sought.stateHash).toMatch(/^[a-f0-9]{16}$/);
    expect(Object.keys(sought.layers).sort()).toEqual([
      "blurPx",
      "detailEdgeProgress",
      "distanceReveal",
      "inkOpacity",
      "lowFrequencyOpacity",
      "signedDarkOpacity",
      "signedLightOpacity",
      "sourceOpacity",
      "strokeProgress",
      "strongEdgeProgress",
      "transitionOpacity"
    ]);
  });

  test("keeps reveal progress monotonic and holds a stable final image for observation", () => {
    const shot = program();
    const samples = [0, 2, 4, 5, 6, 7, 8].map((time) => sampleShotProgram(shot, time));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index].layers.strokeProgress).toBeGreaterThanOrEqual(samples[index - 1].layers.strokeProgress);
      expect(samples[index].layers.distanceReveal).toBeGreaterThanOrEqual(samples[index - 1].layers.distanceReveal);
    }

    const observationStart = sampleShotProgram(shot, 8);
    const observationMiddle = sampleShotProgram(shot, 9.25);
    const observationEnd = sampleShotProgram(shot, 10);
    expect(observationMiddle.layers).toEqual(observationStart.layers);
    expect(observationEnd.layers).toEqual(observationStart.layers);
    expect(shot.phases.at(-1)!.end - shot.phases.at(-1)!.start).toBeGreaterThanOrEqual(2);
  });

  test("provides a deterministic reduced-motion state without spatial blur", () => {
    const shot = program();
    const first = sampleShotProgram(shot, 5.2, { reducedMotion: true });
    const second = sampleShotProgram(shot, 5.2, { reducedMotion: true });

    expect(first).toEqual(second);
    expect(first.reducedMotion).toBe(true);
    expect(first.layers.blurPx).toBe(0);
    expect([0, 1]).toContain(first.layers.strokeProgress);
    expect([0, 1]).toContain(first.layers.distanceReveal);
    expect(first.camera).toEqual({
      panX: 0,
      panY: 0,
      zoom: 1,
      parallax: 0,
      layerOffsets: { backgroundX: 0, backgroundY: 0, middleX: 0, middleY: 0, foregroundX: 0, foregroundY: 0 }
    });
  });

  test("compiles bounded saliency camera curves and holds them during observation", () => {
    const shot = program();
    expect(Math.abs(shot.camera.automations.panX.at(-1)!.value)).toBeLessThanOrEqual(0.03 * 900 / 1600);
    expect(Math.abs(shot.camera.automations.panY.at(-1)!.value)).toBeLessThanOrEqual(0.03);
    expect(shot.camera.automations.zoom.at(-1)!.value).toBeGreaterThan(1);
    expect(shot.camera.automations.zoom.at(-1)!.value).toBeLessThanOrEqual(1.06);

    const moving = sampleShotProgram(shot, 5);
    const settled = sampleShotProgram(shot, 8);
    const held = sampleShotProgram(shot, 9.75);
    expect(moving.camera.parallax).toBeGreaterThan(0);
    expect(settled.camera).toEqual(held.camera);
    expect(settled.camera.layerOffsets.backgroundX).not.toBe(settled.camera.layerOffsets.foregroundX);
    expect(settled.camera.layerOffsets.backgroundY).not.toBe(settled.camera.layerOffsets.foregroundY);
  });

  test("rejects a Shot Program whose phases no longer cover duration contiguously", () => {
    const shot = program();
    const invalid = {
      ...shot,
      phases: shot.phases.map((phase, index) => index === 2 ? { ...phase, start: 4.5 } : phase)
    };
    expect(() => ShotProgramSchema.parse(invalid)).toThrow(/contiguous/i);
  });

  test("rejects stale identity, out-of-range values, and curves that do not span the Shot", () => {
    const shot = program();
    expect(() => ShotProgramSchema.parse({
      ...shot,
      treatment: { ...shot.treatment, render: { ...shot.treatment.render, lineWidth: 2 } }
    })).toThrow(/hash does not match/i);
    expect(() => ShotProgramSchema.parse({
      ...shot,
      automations: {
        ...shot.automations,
        sourceOpacity: shot.automations.sourceOpacity.map((point, index) => index === 1 ? { ...point, value: 1.2 } : point)
      }
    })).toThrow();
    expect(() => ShotProgramSchema.parse({
      ...shot,
      automations: {
        ...shot.automations,
        blurPx: shot.automations.blurPx.slice(1)
      }
    })).toThrow(/span Scene Time/i);
  });
});
