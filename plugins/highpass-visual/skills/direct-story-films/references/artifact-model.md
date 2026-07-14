# Highpass Visual Artifact Model

## Canonical artifacts

- **Source Material**: the user's original story, article, essay, or structured content plus provenance.
- **Story Model**: normalized beats, entities, motifs, emotional turns, and continuity constraints.
- **Treatment**: an authored combination of narrative, art, motion, frequency, and renderer choices.
- **Shot Program**: ordered shots with durations, transitions, composition, and absolute Scene Time phases.
- **Image Candidate**: generated or imported image with prompt or source provenance.
- **Selected Image**: the approved candidate locked to a shot before compilation.
- **Shot Program Plan**: a Director artifact binding a Shot, Selected Image hash, Treatment, and seed while explicitly awaiting its Vision Asset. It becomes a renderable Shot Program only after vision compilation.
- **Vision Asset**: reusable OpenCV output such as a frequency layer, contour, stroke, mask, distance field, or luminance map.
- **Transition Intent**: the Director-authored narrative purpose of an adjacent Shot boundary and an optional locked method.
- **Transition Asset**: pairwise OpenCV evidence and renderer data: Homography, flow, confidence, occlusion, contour correspondence, and quality-gated selection.
- **Transition Program**: a pure absolute-time contract sampling the outgoing Shot tail and incoming Shot head over one shared interval.
- **Visual State**: complete renderer input sampled at an exact Scene Time.
- **Delivery**: encoded video plus the frame and audio manifests that produced it.
- **Quality Evidence**: deterministic checks, probe frames, contact sheets, metrics, warnings, and validation results.

## Invariants

1. Every derived artifact records the identifiers and settings of its inputs.
2. A selected image is immutable for the compilation that references it.
3. Vision Assets use normalized image-space coordinates unless a schema explicitly says otherwise.
4. Scene Time is local to one Shot. Story Time maps those local clocks through shared Transition Program overlaps; frame `n` samples Story Time `n / fps`.
5. Identical inputs, settings, seed, and time produce identical artifact bytes or visual state.
6. A delivery is not complete without Quality Evidence and an exact expected-versus-actual frame count.
7. Narrative identity excludes Vision Asset paths and renderer settings; controlled Treatment comparisons validate those visual bindings separately.
8. A locked advanced transition that fails its quality gate is an explicit error. An unlocked method records each rejection before a deterministic fallback.
9. For an N-frame pairwise overlap, Story publication removes N outgoing-tail and N incoming-head frames, then inserts N Transition frames.
