export function canonicalizeTransition(value) {
  if (Array.isArray(value)) return value.map(canonicalizeTransition);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalizeTransition(entry)]));
  return value;
}

export function stableTransitionStringify(value) {
  return JSON.stringify(canonicalizeTransition(value));
}

export function transitionFnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function round(value) {
  return Number(value.toFixed(6));
}

export function sampleTransitionProgramRuntime(program, transitionTime, reducedMotion = false) {
  const time = round(Math.max(0, Math.min(program.duration, transitionTime)));
  const blend = round(time / program.duration);
  const spatialWarp = reducedMotion ? 0 : round(blend * blend * (3 - 2 * blend));
  const withoutHash = {
    schemaVersion: "highpass.transition-state.v1",
    programHash: program.programHash,
    method: program.method,
    transitionTime: time,
    outgoingSceneTime: round(program.outgoing.localStart + time),
    incomingSceneTime: time,
    blend,
    spatialWarp,
    reducedMotion
  };
  return { ...withoutHash, stateHash: transitionFnv1a64(stableTransitionStringify(withoutHash)) };
}
