export function canonicalize(value: unknown): unknown;
export function stableStringify(value: unknown): string;
export function fnv1a64(value: string): string;
export function sampleShotProgramRuntime(
  program: {
    programHash: string;
    shot: { duration: number };
    phases: Array<{ id: string; start: number; end: number }>;
    automations: Record<string, Array<{ time: number; value: number; easing: "linear" | "ease-in-out" | "hold" }>>;
  },
  sceneTime: number,
  reducedMotion?: boolean
): unknown;
