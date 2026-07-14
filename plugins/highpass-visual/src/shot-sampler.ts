import { createHash } from "node:crypto";
import * as z from "zod/v4";

import { sampleShotProgramRuntime, stableStringify } from "../runtime/shot-sampler-runtime.js";
import { TransitionIntentSchema } from "./director-compiler.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PHASE_IDS = ["atmosphere", "outline", "inward-reveal", "settle", "observation"] as const;
const VISION_CHANNEL_IDS = ["low-frequency", "signed-detail", "signed-detail-light", "signed-detail-dark", "strong-edge", "detail-edge", "subject-mask", "distance-field"] as const;
const LayerStateSchema = z.object({
  lowFrequencyOpacity: z.number().min(0).max(1),
  blurPx: z.number().nonnegative(),
  strongEdgeProgress: z.number().min(0).max(1),
  detailEdgeProgress: z.number().min(0).max(1),
  strokeProgress: z.number().min(0).max(1),
  distanceReveal: z.number().min(0).max(1),
  sourceOpacity: z.number().min(0).max(1),
  inkOpacity: z.number().min(0).max(1),
  signedLightOpacity: z.number().min(0).max(1),
  signedDarkOpacity: z.number().min(0).max(1),
  transitionOpacity: z.number().min(0).max(1)
});

export const ShotTransitionSchema = TransitionIntentSchema;

const KeyframeBaseSchema = z.object({
  time: z.number().nonnegative(),
  easing: z.enum(["linear", "ease-in-out", "hold"])
});
function curveSchema(value: z.ZodNumber) {
  return z.array(KeyframeBaseSchema.extend({ value })).min(2).superRefine((curve, context) => {
    for (let index = 1; index < curve.length; index += 1) {
      if (curve[index].time <= curve[index - 1].time) {
        context.addIssue({ code: "custom", message: "Automation keyframes must use strictly increasing Scene Time." });
      }
    }
  });
}
const UnitCurveSchema = curveSchema(z.number().min(0).max(1));
const BlurCurveSchema = curveSchema(z.number().min(0).max(80));
const PanCurveSchema = curveSchema(z.number().min(-0.03).max(0.03));
const ZoomCurveSchema = curveSchema(z.number().min(1).max(1.06));

const RenderTreatmentSchema = z.object({
  backgroundColor: z.string().regex(/^#[a-f0-9]{6}$/i),
  inkColor: z.string().regex(/^#[a-f0-9]{6}$/i),
  lineWidth: z.number().min(0.25).max(12),
  distanceSoftness: z.number().min(0.001).max(0.25),
  strongEdgeGain: z.number().min(0).max(1),
  detailEdgeGain: z.number().min(0).max(1),
  signedLightGain: z.number().min(0).max(1),
  signedDarkGain: z.number().min(0).max(1),
  distanceMaskEnabled: z.boolean()
});

const InkRevealControlsSchema = z.object({
  lineWidth: z.number().min(0.25).max(12).describe("Width of contour and skeleton strokes; affects Region Contours and Open Strokes.").default(1.35),
  distanceSoftness: z.number().min(0.001).max(0.25).describe("Feather width of the inward reveal; affects Distance Field and Subject Mask.").default(0.035),
  atmosphereGain: z.number().min(0.1).max(1).describe("Maximum low-frequency atmosphere opacity.").default(0.66)
}).strict();
const MemoryFocusControlsSchema = z.object({
  atmosphereGain: z.number().min(0.1).max(1).describe("Strength of the first low-frequency memory impression.").default(0.78),
  initialBlurPx: z.number().min(4).max(40).describe("Starting blur applied to both low-frequency and source layers.").default(22),
  structuralEmphasis: z.number().min(0.1).max(1).describe("Strong-edge prominence during focus recovery.").default(0.62),
  fineDetailClarity: z.number().min(0.05).max(1).describe("Fine-detail presence after structure resolves.").default(0.36)
}).strict();
const EtchedLightControlsSchema = z.object({
  lineWidth: z.number().min(0.25).max(6).describe("Width of etched contour and skeleton linework.").default(1.1),
  lightGain: z.number().min(0.05).max(1).describe("Gain for positive signed high-frequency responses.").default(0.52),
  darkGain: z.number().min(0.05).max(1).describe("Gain for negative signed high-frequency responses.").default(0.46),
  textureCeiling: z.number().min(0).max(0.17).describe("Hard upper bound for weak texture, always at most half the structural gain.").default(0.14)
}).strict();
export const TreatmentControlOverridesSchema = z.object({
  "ink-reveal": InkRevealControlsSchema.partial().optional(),
  "memory-focus": MemoryFocusControlsSchema.partial().optional(),
  "etched-light": EtchedLightControlsSchema.partial().optional()
}).strict();

const channelControl = (meaning: string, min: number, max: number, defaultValue: number, affectedChannels: string[]) => ({
  meaning,
  min,
  max,
  default: defaultValue,
  affectedChannels
});

export const TREATMENT_CONTROL_DEFINITIONS = {
  "ink-reveal": {
    label: "Ink Reveal",
    controls: {
      lineWidth: channelControl("Width of the authored contour and skeleton strokes.", 0.25, 12, 1.35, ["region-contours", "open-strokes"]),
      distanceSoftness: channelControl("Feather width at the inward signed-distance reveal boundary.", 0.001, 0.25, 0.035, ["distance-field", "subject-mask"]),
      atmosphereGain: channelControl("Maximum presence of the low-frequency atmosphere layer.", 0.1, 1, 0.66, ["low-frequency"])
    }
  },
  "memory-focus": {
    label: "Memory Focus",
    controls: {
      atmosphereGain: channelControl("Strength of the first soft low-frequency memory impression.", 0.1, 1, 0.78, ["low-frequency"]),
      initialBlurPx: channelControl("Starting optical blur before structural and fine focus arrive.", 4, 40, 22, ["low-frequency", "source"]),
      structuralEmphasis: channelControl("Prominence of strong structural edges during focus recovery.", 0.1, 1, 0.62, ["strong-edge"]),
      fineDetailClarity: channelControl("Final amount of fine detail permitted after structure resolves.", 0.05, 1, 0.36, ["detail-edge", "source"])
    }
  },
  "etched-light": {
    label: "Etched Light",
    controls: {
      lineWidth: channelControl("Width of the etched structural linework.", 0.25, 6, 1.1, ["region-contours", "open-strokes"]),
      lightGain: channelControl("Gain applied to positive signed high-frequency responses.", 0.05, 1, 0.52, ["signed-detail-light"]),
      darkGain: channelControl("Gain applied to negative signed high-frequency responses.", 0.05, 1, 0.46, ["signed-detail-dark"]),
      textureCeiling: channelControl("Upper bound for weak detail so structure remains dominant.", 0, 0.17, 0.14, ["detail-edge"])
    }
  }
} as const;

const InkRevealTreatmentSchema = z.object({
  id: z.literal("ink-reveal"),
  controls: InkRevealControlsSchema,
  render: RenderTreatmentSchema,
  requiredChannels: z.array(z.enum(VISION_CHANNEL_IDS)).min(1)
}).strict();
const MemoryFocusTreatmentSchema = z.object({
  id: z.literal("memory-focus"),
  controls: MemoryFocusControlsSchema,
  render: RenderTreatmentSchema,
  requiredChannels: z.array(z.enum(VISION_CHANNEL_IDS)).min(1)
}).strict();
const EtchedLightTreatmentSchema = z.object({
  id: z.literal("etched-light"),
  controls: EtchedLightControlsSchema,
  render: RenderTreatmentSchema,
  requiredChannels: z.array(z.enum(VISION_CHANNEL_IDS)).min(1)
}).strict();
export const TreatmentSchema = z.discriminatedUnion("id", [InkRevealTreatmentSchema, MemoryFocusTreatmentSchema, EtchedLightTreatmentSchema]);

export const ShotProgramSchema = z.object({
  schemaVersion: z.literal("highpass.shot-program.v1"),
  programHash: z.string().regex(HASH_PATTERN),
  shot: z.object({
    id: z.string().min(1),
    attentionTarget: z.string().min(1),
    duration: z.number().min(5).max(120),
    seed: z.string().min(1),
    directionHash: z.string().regex(HASH_PATTERN),
    transitionOut: ShotTransitionSchema,
    narrativeIdentityHash: z.string().regex(HASH_PATTERN)
  }),
  selectedImage: z.object({ id: z.string().min(1), sourceHash: z.string().regex(HASH_PATTERN) }),
  visionAsset: z.object({ artifactHash: z.string().regex(HASH_PATTERN), manifestPath: z.string().min(1) }),
  treatment: TreatmentSchema,
  camera: z.object({
    saliencyCentroid: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
    saliencyBounds: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict(),
    automations: z.object({
      panX: PanCurveSchema,
      panY: PanCurveSchema,
      zoom: ZoomCurveSchema,
      parallax: UnitCurveSchema
    }).strict()
  }).strict(),
  phases: z.array(z.object({
    id: z.enum(PHASE_IDS),
    start: z.number().nonnegative(),
    end: z.number().positive()
  })).length(5),
  automations: z.object({
    lowFrequencyOpacity: UnitCurveSchema,
    blurPx: BlurCurveSchema,
    strongEdgeProgress: UnitCurveSchema,
    detailEdgeProgress: UnitCurveSchema,
    strokeProgress: UnitCurveSchema,
    distanceReveal: UnitCurveSchema,
    sourceOpacity: UnitCurveSchema,
    inkOpacity: UnitCurveSchema,
    signedLightOpacity: UnitCurveSchema,
    signedDarkOpacity: UnitCurveSchema
  })
}).superRefine((program, context) => {
  const tolerance = 1e-9;
  for (let index = 0; index < PHASE_IDS.length; index += 1) {
    const phase = program.phases[index];
    if (phase.id !== PHASE_IDS[index]) {
      context.addIssue({ code: "custom", message: "Shot Program phases must use the canonical order." });
    }
    if (phase.end <= phase.start) {
      context.addIssue({ code: "custom", message: "Every phase must have a positive duration." });
    }
    if (index === 0 && Math.abs(phase.start) > tolerance) {
      context.addIssue({ code: "custom", message: "Shot Program phases must start at Scene Time zero." });
    }
    if (index > 0 && Math.abs(phase.start - program.phases[index - 1].end) > tolerance) {
      context.addIssue({ code: "custom", message: "Shot Program phases must be contiguous." });
    }
  }
  const observation = program.phases.at(-1)!;
  const transitionStart = program.shot.duration - (program.shot.transitionOut.lockedMethod === "fade-to-black"
    ? program.shot.transitionOut.duration
    : 0);
  if (Math.abs(observation.end - transitionStart) > tolerance) {
    context.addIssue({ code: "custom", message: "Shot Program phases must end where its explicit transition action begins." });
  }
  if (observation.end - observation.start < 2 - tolerance) {
    context.addIssue({ code: "custom", message: "Every Treatment requires at least two seconds of stable observation." });
  }
  if (transitionStart < 3 - tolerance) {
    context.addIssue({ code: "custom", message: "A Shot must retain animation time and at least two seconds of observation before its transition." });
  }
  for (const curve of Object.values(program.automations)) {
    if (Math.abs(curve[0].time) > tolerance || Math.abs(curve.at(-1)!.time - program.shot.duration) > tolerance) {
      context.addIssue({ code: "custom", message: "Every automation curve must span Scene Time zero through the full Shot duration." });
    }
  }
  for (const curve of Object.values(program.camera.automations)) {
    if (Math.abs(curve[0].time) > tolerance || Math.abs(curve.at(-1)!.time - program.shot.duration) > tolerance) {
      context.addIssue({ code: "custom", message: "Every camera curve must span Scene Time zero through the full Shot duration." });
    }
  }
  if (program.programHash !== programContentHash(program)) {
    context.addIssue({ code: "custom", message: "Shot Program hash does not match its bound content." });
  }
  if (program.shot.narrativeIdentityHash !== narrativeIdentityHash(program)) {
    context.addIssue({ code: "custom", message: "Narrative identity hash does not match the Shot and source bindings." });
  }
});

export type ShotProgram = z.infer<typeof ShotProgramSchema>;
export type LayerState = z.infer<typeof LayerStateSchema>;

export const VisualStateSchema = z.object({
  schemaVersion: z.literal("highpass.visual-state.v1"),
  programHash: z.string().regex(HASH_PATTERN),
  sceneTime: z.number().nonnegative(),
  activePhase: z.enum([...PHASE_IDS, "transition"]),
  reducedMotion: z.boolean(),
  layers: LayerStateSchema,
  camera: z.object({
    panX: z.number().min(-0.03).max(0.03),
    panY: z.number().min(-0.03).max(0.03),
    zoom: z.number().min(1).max(1.06),
    parallax: z.number().min(0).max(1),
    layerOffsets: z.object({
      backgroundX: z.number().min(-0.03).max(0.03),
      backgroundY: z.number().min(-0.03).max(0.03),
      middleX: z.number().min(-0.03).max(0.03),
      middleY: z.number().min(-0.03).max(0.03),
      foregroundX: z.number().min(-0.03).max(0.03),
      foregroundY: z.number().min(-0.03).max(0.03)
    }).strict()
  }).strict(),
  stateHash: z.string().regex(/^[a-f0-9]{16}$/)
});

export type VisualState = z.infer<typeof VisualStateSchema>;

export type CreateInkRevealShotProgramInput = {
  shotId: string;
  attentionTarget: string;
  duration: number;
  directionHash?: string;
  transitionOut?: z.input<typeof ShotTransitionSchema>;
  selectedImageId: string;
  selectedImageHash: string;
  visionAssetHash: string;
  visionAssetManifestPath: string;
  saliency?: {
    centroid: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
  };
  sourceDimensions?: { width: number; height: number };
};

export type TreatmentId = keyof typeof TREATMENT_CONTROL_DEFINITIONS;
export type CreateTreatmentShotProgramInput = CreateInkRevealShotProgramInput & {
  treatmentId: TreatmentId;
  controls?: Record<string, number>;
  seed: string;
};

function programContentHash(program: Omit<ShotProgram, "programHash"> | ShotProgram) {
  const { programHash: _ignored, ...content } = program as ShotProgram;
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

function narrativeIdentityHash(program: {
  shot: { id: string; attentionTarget: string; duration: number; seed: string; directionHash: string; transitionOut: z.infer<typeof ShotTransitionSchema> };
  selectedImage: { id: string; sourceHash: string };
}) {
  return createHash("sha256").update(stableStringify({
    shot: {
      id: program.shot.id,
      attentionTarget: program.shot.attentionTarget,
      duration: program.shot.duration,
      seed: program.shot.seed,
      directionHash: program.shot.directionHash,
      transitionOut: program.shot.transitionOut
    },
    selectedImage: program.selectedImage
  })).digest("hex");
}

function round(value: number) {
  return Number(value.toFixed(6));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function keyframe(time: number, value: number, easing: "linear" | "ease-in-out" | "hold" = "ease-in-out") {
  return { time: round(time), value, easing };
}

function resolveTreatment(treatmentId: TreatmentId, controls: Record<string, number> | undefined) {
  if (treatmentId === "ink-reveal") {
    const parsed = InkRevealControlsSchema.parse(controls ?? {});
    return TreatmentSchema.parse({
      id: treatmentId,
      controls: parsed,
      render: {
        backgroundColor: "#0b0d12",
        inkColor: "#e8dcc4",
        lineWidth: parsed.lineWidth,
        distanceSoftness: parsed.distanceSoftness,
        strongEdgeGain: 0.24,
        detailEdgeGain: 0.16,
        signedLightGain: 0,
        signedDarkGain: 0,
        distanceMaskEnabled: true
      },
      requiredChannels: ["low-frequency", "strong-edge", "detail-edge", "subject-mask", "distance-field"]
    });
  }
  if (treatmentId === "memory-focus") {
    const parsed = MemoryFocusControlsSchema.parse(controls ?? {});
    return TreatmentSchema.parse({
      id: treatmentId,
      controls: parsed,
      render: {
        backgroundColor: "#11131a",
        inkColor: "#d7d4ca",
        lineWidth: 0.8,
        distanceSoftness: 0.06,
        strongEdgeGain: parsed.structuralEmphasis * 0.42,
        detailEdgeGain: parsed.fineDetailClarity * 0.24,
        signedLightGain: 0,
        signedDarkGain: 0,
        distanceMaskEnabled: false
      },
      requiredChannels: ["low-frequency", "strong-edge", "detail-edge"]
    });
  }
  if (treatmentId === "etched-light") {
    const parsed = EtchedLightControlsSchema.parse(controls ?? {});
    return TreatmentSchema.parse({
      id: treatmentId,
      controls: parsed,
      render: {
        backgroundColor: "#090b0e",
        inkColor: "#d7c9a8",
        lineWidth: parsed.lineWidth,
        distanceSoftness: 0.025,
        strongEdgeGain: 0.34,
        detailEdgeGain: parsed.textureCeiling,
        signedLightGain: parsed.lightGain,
        signedDarkGain: parsed.darkGain,
        distanceMaskEnabled: false
      },
      requiredChannels: ["low-frequency", "signed-detail-light", "signed-detail-dark", "strong-edge", "detail-edge"]
    });
  }
  throw new Error(`Unknown Treatment: ${String(treatmentId)}`);
}

function zeroCurve(duration: number) {
  return [keyframe(0, 0, "hold"), keyframe(duration, 0, "hold")];
}

export function createTreatmentShotProgram(input: CreateTreatmentShotProgramInput): ShotProgram {
  const duration = input.duration;
  const transitionOut = ShotTransitionSchema.parse(input.transitionOut ?? {
    intent: "terminal",
    duration: 0,
    reason: "No outgoing transition was directed for this standalone preview.",
    lockedMethod: "cut"
  });
  const contentDuration = round(duration - (transitionOut.lockedMethod === "fade-to-black" ? transitionOut.duration : 0));
  const animationDuration = round(contentDuration - 2);
  const atmosphereEnd = round(animationDuration * 0.1875);
  const outlineEnd = round(animationDuration * 0.5);
  const revealEnd = round(animationDuration * 0.875);
  const settleEnd = animationDuration;
  const phases = [
    { id: "atmosphere" as const, start: 0, end: atmosphereEnd },
    { id: "outline" as const, start: atmosphereEnd, end: outlineEnd },
    { id: "inward-reveal" as const, start: outlineEnd, end: revealEnd },
    { id: "settle" as const, start: revealEnd, end: settleEnd },
    { id: "observation" as const, start: settleEnd, end: contentDuration }
  ];
  const selectedImage = { id: input.selectedImageId, sourceHash: input.selectedImageHash };
  const visionAsset = { artifactHash: input.visionAssetHash, manifestPath: input.visionAssetManifestPath };
  const directionHash = input.directionHash ?? createHash("sha256").update(stableStringify({
    shotId: input.shotId,
    attentionTarget: input.attentionTarget,
    duration
  })).digest("hex");
  const identityInput = {
    shot: { id: input.shotId, attentionTarget: input.attentionTarget, duration, seed: input.seed, directionHash, transitionOut },
    selectedImage
  };
  const saliencyCentroid = input.saliency?.centroid ?? { x: 0.5, y: 0.5 };
  const saliencyBounds = input.saliency?.bounds ?? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const sourceWidth = input.sourceDimensions?.width ?? 1;
  const sourceHeight = input.sourceDimensions?.height ?? 1;
  const shortDimension = Math.min(sourceWidth, sourceHeight);
  const maximumPanX = 0.03 * shortDimension / sourceWidth;
  const maximumPanY = 0.03 * shortDimension / sourceHeight;
  const targetPanX = round(clamp((0.5 - saliencyCentroid.x) * 0.06, -maximumPanX, maximumPanX));
  const targetPanY = round(clamp((0.5 - saliencyCentroid.y) * 0.06, -maximumPanY, maximumPanY));
  const subjectCompactness = 1 - clamp(Math.max(saliencyBounds.width, saliencyBounds.height), 0, 1);
  const targetZoom = round(1 + clamp(0.015 + subjectCompactness * 0.05, 0.015, 0.06));
  const camera = {
    saliencyCentroid,
    saliencyBounds,
    automations: {
      panX: [keyframe(0, 0), keyframe(settleEnd, targetPanX), keyframe(duration, targetPanX, "hold")],
      panY: [keyframe(0, 0), keyframe(settleEnd, targetPanY), keyframe(duration, targetPanY, "hold")],
      zoom: [keyframe(0, 1), keyframe(settleEnd, targetZoom), keyframe(duration, targetZoom, "hold")],
      parallax: [keyframe(0, 0), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")]
    }
  };
  const treatment = resolveTreatment(input.treatmentId, input.controls);
  let automations: ShotProgram["automations"];
  if (treatment.id === "ink-reveal") {
    automations = {
      lowFrequencyOpacity: [keyframe(0, 0.22), keyframe(atmosphereEnd, treatment.controls.atmosphereGain), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      blurPx: [keyframe(0, 18), keyframe(outlineEnd, 8), keyframe(settleEnd, 0), keyframe(duration, 0, "hold")],
      strongEdgeProgress: [keyframe(0, 0, "hold"), keyframe(atmosphereEnd, 0), keyframe(outlineEnd, 1), keyframe(duration, 1, "hold")],
      detailEdgeProgress: [keyframe(0, 0, "hold"), keyframe(revealEnd, 0), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      strokeProgress: [keyframe(0, 0, "hold"), keyframe(atmosphereEnd, 0), keyframe(outlineEnd, 1), keyframe(duration, 1, "hold")],
      distanceReveal: [keyframe(0, 0, "hold"), keyframe(outlineEnd, 0), keyframe(revealEnd, 1), keyframe(duration, 1, "hold")],
      sourceOpacity: [keyframe(0, 0.04), keyframe(outlineEnd, 0.14), keyframe(revealEnd, 0.88), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      inkOpacity: [keyframe(0, 0, "hold"), keyframe(atmosphereEnd, 0), keyframe(outlineEnd, 0.88), keyframe(settleEnd, 0.34), keyframe(duration, 0.34, "hold")],
      signedLightOpacity: zeroCurve(duration),
      signedDarkOpacity: zeroCurve(duration)
    };
  } else if (treatment.id === "memory-focus") {
    const blur = treatment.controls.initialBlurPx;
    automations = {
      lowFrequencyOpacity: [keyframe(0, 0.35), keyframe(atmosphereEnd, treatment.controls.atmosphereGain), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      blurPx: [keyframe(0, blur), keyframe(atmosphereEnd, blur * 0.84), keyframe(outlineEnd, blur * 0.52), keyframe(revealEnd, blur * 0.16), keyframe(settleEnd, 0), keyframe(duration, 0, "hold")],
      strongEdgeProgress: [keyframe(0, 0), keyframe(atmosphereEnd, 0.08), keyframe(outlineEnd, 0.72), keyframe(revealEnd, 1), keyframe(duration, 1, "hold")],
      detailEdgeProgress: [keyframe(0, 0), keyframe(outlineEnd, 0.04), keyframe(revealEnd, 0.48), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      strokeProgress: zeroCurve(duration),
      distanceReveal: zeroCurve(duration),
      sourceOpacity: [keyframe(0, 0.1), keyframe(atmosphereEnd, 0.24), keyframe(outlineEnd, 0.5), keyframe(revealEnd, 0.84), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      inkOpacity: zeroCurve(duration),
      signedLightOpacity: zeroCurve(duration),
      signedDarkOpacity: zeroCurve(duration)
    };
  } else {
    automations = {
      lowFrequencyOpacity: [keyframe(0, 0.12), keyframe(atmosphereEnd, 0.42), keyframe(settleEnd, 0.72), keyframe(duration, 0.72, "hold")],
      blurPx: [keyframe(0, 7), keyframe(outlineEnd, 2), keyframe(settleEnd, 0), keyframe(duration, 0, "hold")],
      strongEdgeProgress: [keyframe(0, 0), keyframe(atmosphereEnd, 0), keyframe(outlineEnd, 1), keyframe(duration, 1, "hold")],
      detailEdgeProgress: [keyframe(0, 0), keyframe(revealEnd, 0.08), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      strokeProgress: [keyframe(0, 0), keyframe(atmosphereEnd, 0), keyframe(outlineEnd, 1), keyframe(duration, 1, "hold")],
      distanceReveal: zeroCurve(duration),
      sourceOpacity: [keyframe(0, 0.04), keyframe(outlineEnd, 0.18), keyframe(revealEnd, 0.5), keyframe(settleEnd, 0.62), keyframe(duration, 0.62, "hold")],
      inkOpacity: [keyframe(0, 0), keyframe(atmosphereEnd, 0.05), keyframe(outlineEnd, 0.58), keyframe(settleEnd, 0.42), keyframe(duration, 0.42, "hold")],
      signedLightOpacity: [keyframe(0, 0), keyframe(outlineEnd, 0), keyframe(revealEnd, 0.78), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")],
      signedDarkOpacity: [keyframe(0, 0), keyframe(outlineEnd, 0), keyframe(revealEnd, 0.72), keyframe(settleEnd, 1), keyframe(duration, 1, "hold")]
    };
  }
  const withoutHash = {
    schemaVersion: "highpass.shot-program.v1" as const,
    shot: { ...identityInput.shot, narrativeIdentityHash: narrativeIdentityHash(identityInput) },
    selectedImage,
    visionAsset,
    treatment,
    camera,
    phases,
    automations
  };
  const programHash = programContentHash(withoutHash as Omit<ShotProgram, "programHash">);
  return ShotProgramSchema.parse({ ...withoutHash, programHash });
}

export function createInkRevealShotProgram(input: CreateInkRevealShotProgramInput): ShotProgram {
  return createTreatmentShotProgram({
    ...input,
    treatmentId: "ink-reveal",
    seed: `default:${input.shotId}`
  });
}

export function assertComparableTreatments(inputs: ShotProgram[]) {
  if (inputs.length < 2) throw new Error("A Treatment comparison needs at least two candidates.");
  const programs = inputs.map((program) => ShotProgramSchema.parse(program));
  const identity = programs[0].shot.narrativeIdentityHash;
  if (programs.some((program) => program.shot.narrativeIdentityHash !== identity)) {
    throw new Error("Treatment candidates changed narrative identity and cannot be compared.");
  }
  const visionAssetHash = programs[0].visionAsset.artifactHash;
  if (programs.some((program) => program.visionAsset.artifactHash !== visionAssetHash)) {
    throw new Error("Treatment candidates must bind the same Vision Asset for a controlled comparison.");
  }
  return programs;
}

export function sampleShotProgram(
  input: ShotProgram,
  sceneTime: number,
  options: { reducedMotion?: boolean } = {}
): VisualState {
  const program = ShotProgramSchema.parse(input);
  return VisualStateSchema.parse(sampleShotProgramRuntime(program, sceneTime, options.reducedMotion === true));
}
