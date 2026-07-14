import type { TransitionProgram, TransitionState } from "../src/transition-program.js";

export function canonicalizeTransition(value: unknown): unknown;
export function stableTransitionStringify(value: unknown): string;
export function transitionFnv1a64(value: string): string;
export function sampleTransitionProgramRuntime(program: TransitionProgram, transitionTime: number, reducedMotion?: boolean): TransitionState;
