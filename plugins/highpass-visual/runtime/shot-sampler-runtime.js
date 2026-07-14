export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function fnv1a64(value) {
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

function ease(value, kind) {
  if (kind === "hold") return 0;
  if (kind === "linear") return value;
  return value * value * (3 - 2 * value);
}

function sampleCurve(curve, time) {
  if (time <= curve[0].time) return curve[0].value;
  for (let index = 0; index < curve.length - 1; index += 1) {
    const left = curve[index];
    const right = curve[index + 1];
    if (time <= right.time) {
      if (time === right.time) return right.value;
      const progress = (time - left.time) / (right.time - left.time);
      const amount = ease(progress, left.easing);
      return left.value + (right.value - left.value) * amount;
    }
  }
  return curve.at(-1).value;
}

export function sampleShotProgramRuntime(program, sceneTime, reducedMotion = false) {
  const time = round(Math.max(0, Math.min(program.shot.duration, sceneTime)));
  const fadeDuration = program.shot.transitionOut.lockedMethod === "fade-to-black"
    ? program.shot.transitionOut.duration
    : 0;
  const transitionStart = program.shot.duration - fadeDuration;
  const inTransition = fadeDuration > 0 && time >= transitionStart;
  const activePhase = inTransition
    ? "transition"
    : program.phases.find((phase) => time >= phase.start && time < phase.end)?.id ?? "observation";
  const layers = Object.fromEntries(
    Object.entries(program.automations).map(([name, curve]) => [name, round(sampleCurve(curve, time))])
  );
  layers.transitionOpacity = inTransition
    ? round(Math.max(0, 1 - (time - transitionStart) / fadeDuration))
    : 1;
  if (reducedMotion) {
    layers.blurPx = 0;
    for (const name of ["strongEdgeProgress", "detailEdgeProgress", "strokeProgress", "distanceReveal"]) {
      layers[name] = layers[name] >= 0.5 ? 1 : 0;
    }
  }
  const sampledCamera = Object.fromEntries(
    Object.entries(program.camera.automations).map(([name, curve]) => [name, round(sampleCurve(curve, time))])
  );
  const camera = reducedMotion
    ? {
        panX: 0,
        panY: 0,
        zoom: 1,
        parallax: 0,
        layerOffsets: { backgroundX: 0, backgroundY: 0, middleX: 0, middleY: 0, foregroundX: 0, foregroundY: 0 }
      }
    : {
        ...sampledCamera,
        layerOffsets: {
          backgroundX: round(sampledCamera.panX * sampledCamera.parallax * 0.25),
          backgroundY: round(sampledCamera.panY * sampledCamera.parallax * 0.25),
          middleX: round(sampledCamera.panX * sampledCamera.parallax * 0.6),
          middleY: round(sampledCamera.panY * sampledCamera.parallax * 0.6),
          foregroundX: round(sampledCamera.panX * sampledCamera.parallax),
          foregroundY: round(sampledCamera.panY * sampledCamera.parallax)
        }
      };
  const withoutHash = {
    schemaVersion: "highpass.visual-state.v1",
    programHash: program.programHash,
    sceneTime: time,
    activePhase,
    reducedMotion,
    layers,
    camera
  };
  return { ...withoutHash, stateHash: fnv1a64(stableStringify(withoutHash)) };
}
