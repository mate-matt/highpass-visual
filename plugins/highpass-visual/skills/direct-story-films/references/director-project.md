# Director Project Draft Contract

The Skill authors narrative judgment in `highpass.director-project-draft.v1`; the deterministic Director Compiler validates and content-addresses it.

Required collections are `beats`, `shots`, `imageSpecifications`, `imageCandidates`, `selections`, and `shotProgramPlans`. Use one-based contiguous order. A Beat records exactly one meaningful `change.from -> change.to`. A Shot records one `purpose`, one `attentionTarget`, one image specification, one supported Treatment, and one explicit transition reason.

`transitionOut` uses `{ intent, duration, reason, lockedMethod? }`. Pairwise `continuity`, `reveal`, and `atmospheric` intents use 0.25–3 seconds; `dislocation` and final `terminal` use zero seconds. The final Shot must use `terminal` locked to `cut`. Legacy `{ type: cut|fade }` drafts are accepted only for migration and compile to canonical values. The brief `targetDuration` is Story Time: sum of local Shot durations minus pairwise overlaps. A locked `fade-to-black` remains non-overlapping.

All Image Specifications bind the shared `storyModel.visualBible`, which owns aspect ratio, palette, and style principles. They reference canonical character, place, prop, and continuity IDs rather than restating identities inconsistently.

Image Candidates from `import` and `codex-imagegen` use the same local-path and SHA-256 contract. A selection copies the accepted candidate path and hash into a distinct Selected Image identity. Never edit or replace accepted bytes in place.

A `shotProgramPlan` is deliberately `awaiting-vision-asset`; it is not a renderable Shot Program yet. It binds the exact typed `visionRecipe` as well as Selected Image hash, Treatment, and seed. The compiler adds `directionHash`; pass it and the Shot's `transitionOut` into final Treatment preparation so Story Model, Beat, composition, selection, or plan changes cannot reuse a stale Shot Program. Pass the accepted image hash as `selectedImage.contentHash` to `compile_vision_asset`; changed bytes are a hard error. Then create the final absolute-time Shot Program from the returned Vision Asset.

See `examples/director/the-signal/director-draft.json` for a complete offline fixture.
