import { describe, expect, test } from "vitest";

import { planStoryFrameSources } from "../src/story-publication.js";

describe("overlap-aware Story frame planning", () => {
  test("replaces outgoing tails and incoming heads with one shared transition interval", () => {
    const plan = planStoryFrameSources(
      [8, 8, 8],
      [
        { outgoingIndex: 0, frameCount: 2 },
        { outgoingIndex: 1, frameCount: 1 }
      ]
    );
    expect(plan).toHaveLength(21);
    expect(plan.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, sourceIndex) => ({ kind: "shot", ownerIndex: 0, sourceIndex })));
    expect(plan.slice(6, 8)).toEqual([
      { kind: "transition", ownerIndex: 0, sourceIndex: 0 },
      { kind: "transition", ownerIndex: 0, sourceIndex: 1 }
    ]);
    expect(plan[8]).toEqual({ kind: "shot", ownerIndex: 1, sourceIndex: 2 });
    expect(plan[13]).toEqual({ kind: "transition", ownerIndex: 1, sourceIndex: 0 });
    expect(plan[14]).toEqual({ kind: "shot", ownerIndex: 2, sourceIndex: 1 });
    expect(plan.at(-1)).toEqual({ kind: "shot", ownerIndex: 2, sourceIndex: 7 });
  });

  test("rejects duplicate and Shot-consuming overlap plans", () => {
    expect(() => planStoryFrameSources([8, 8], [
      { outgoingIndex: 0, frameCount: 2 },
      { outgoingIndex: 0, frameCount: 1 }
    ])).toThrow(/more than one/i);
    expect(() => planStoryFrameSources([4, 4], [{ outgoingIndex: 0, frameCount: 4 }])).toThrow(/entire adjacent Shot/i);
  });
});
