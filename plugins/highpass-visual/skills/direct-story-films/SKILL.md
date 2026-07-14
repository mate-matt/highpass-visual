---
name: direct-story-films
description: Direct a story, article, essay, or other source material into treatments, shots, generated or imported images, OpenCV-derived visual assets, deterministic browser animation, and an exact MP4 delivery. Use when the user asks for story visualization, storyboard-to-video production, contour or blur animation, imagegen-driven motion graphics, or a Highpass Visual project.
---

# Direct Story Films

Turn source material into an authored short film whose visual treatment follows the story. Keep direction, visual compilation, playback, and publication as separate artifact-producing stages.

## Start With The Capability Gate

1. Call the Highpass Visual MCP tool `inspect_runtime` before promising a render or export.
2. If the report is `blocked`, state which deliverable is unavailable and give the report's remediation. Do not install system dependencies unless the user explicitly asks.
3. If the report is `degraded`, continue with the declared fallback and record the warning in Quality Evidence.
4. Do not claim a downstream artifact exists until the tool or script that creates it has completed and the artifact has been inspected.

## Direct The Film

Use this artifact chain; never collapse it into a single prose prompt:

`Source Material -> Story Model -> Beat -> Shot -> Selected Image -> Vision Asset -> Shot Program -> Transition Asset -> Transition Program -> Story Time -> Delivery -> Quality Evidence`

Read [artifact-model.md](references/artifact-model.md) before creating or changing these artifacts.

1. Parse the source into beats, emotional turns, characters or concepts, locations, motifs, and continuity constraints.
2. Compile Beats into Shots with duration, composition, one primary attention target, and a narrative Transition Intent: `continuity`, `reveal`, `atmospheric`, `dislocation`, or final `terminal`. Lock a concrete method only when it is essential; a failed locked quality gate is an error.
3. Author a Director Project draft using the schema in [director-project.md](references/director-project.md). Generate or import Image Candidates through the same candidate contract, then record an explicit selection decision and accepted content hash.
   When the user has not supplied technical settings, prefer the named, bounded recipes and Delivery Profiles in the plugin's `presets/` directory; treat them as starting points, not aesthetic approval.
4. Call `compile_director_project`. Repair any broken references, ordering, continuity, selection, or file-hash error. For each Shot Program Plan, call `compile_vision_asset` with its exact `visionRecipe` and the Selected Image `contentHash`; a hash mismatch means the accepted bytes changed and must not be compiled. Inspect every manifest; never run OpenCV once per browser frame.
5. For each compiled Vision Asset, call `prepare_treatment_comparison` with the Shot, plan seed and `directionHash`, and declared `transitionOut`. Compare Ink Reveal, Memory Focus, and Etched Light under the same narrative identity, source, seed, viewport, duration, and probe times. Select one using the user's preference or the strongest narrative evidence.
6. Retain the selected Shot Program. Its saliency-guided camera and mask-based 2.5D parallax are absolute-time data; Reduced Motion suppresses spatial movement without changing duration. A locked `fade-to-black` remains inside a single Shot Program.
7. For every pairwise intent, call `compile_transition_asset` with the adjacent Vision manifests. Inspect the selected method, fallback chain, rejected methods, thresholds, ORB/RANSAC metrics, directional forward/backward flow confidence and occlusion, raster hashes, and contour coverage. Never claim an advanced method was used when Quality Evidence records a fallback.
8. Call `prepare_transition_program` with both selected Shot Program/preview pairs and the Transition Asset. Review true two-image Cross Dissolve, Distance Field wipe, Homography dissolve, confidence-aware optical-flow dissolve, or contour morph at endpoints and midpoint.
9. Sample every Shot and Transition frame from absolute local time. A Transition Program maps the outgoing tail and incoming head onto one shared interval; its duration is counted once in Story Time.
10. During iteration, call `publish_shot` against an explicit Delivery Profile and inspect its lossless frame manifest, selected-frame hashes, media report, and Quality Evidence.
11. For final delivery, call `publish_story` with exactly one ordered Shot Program/preview pair per Shot and one Transition Program/preview pair per pairwise intent. Existing local audio and subtitle tracks are optional. Retain the final MP4, exact Story frame manifest, overlapping scene ranges, per-Shot and per-Transition evidence, fallbacks, warnings, and project-level Quality Evidence.

## Treatment Rules

- Use high-pass and multiscale edges to reveal structure, accents, texture, or emotional tension—not as a universal full-frame effect.
- Use low-pass layers to control attention, memory, atmosphere, depth, or transitions.
- Use contour paths for closed shapes and open strokes for expressive linework. Preserve both because forcing all edges into closed contours produces poor animation.
- Prefer Canvas 2D for the first renderer. Introduce Three.js or WebGL only when a shot needs depth, particles, shader-scale compositing, or a second proven renderer adapter.
- Preserve the selected image's luminance hierarchy beneath line animation; outlines alone rarely carry enough beauty or narrative focus.
- Ink Reveal uses contour topology plus the signed distance field for an inward authored reveal.
- Memory Focus must move continuously from low-frequency atmosphere to strong structure and then fine clarity; do not introduce discrete blur jumps.
- Etched Light must preserve separate positive and negative signed-detail channels, with weak texture capped below strong structure.
- Use GrabCut only as a measured foreground proposal. Explicit grayscale masks remain authoritative and keep their soft alpha; binary analysis is derived separately. Implausible automatic masks must record their deterministic morphology or full-frame fallback.
- Use optical flow only when forward-backward, photometric, occlusion, and displacement gates pass. Use Homography only when match, inlier, reprojection, corner, and overlap gates pass.
- Treat 2.5D as mask-based layered parallax, not learned depth. OpenCV TELEA background inpainting is a bounded hole-filling step, not scene reconstruction.
- Treat generated preview HTML, its embedded child previews, renderer runtime, and transition rasters as content-addressed evidence. A repaired or substituted renderer must produce a new verified preview/delivery identity before publication.

## Boundaries

- The Director Compiler makes narrative and shot decisions; OpenCV does not.
- The Skill authors narrative judgment; `compile_director_project` only validates and content-addresses the resulting draft.
- The Vision Compiler produces reusable assets; it does not own playback time.
- The Transition Compiler chooses a concrete method from Director intent and measured pair compatibility; it does not change narrative purpose.
- The Shot Sampler is a pure function of Shot Program, Vision Assets, and Scene Time.
- The Transition Sampler is a pure function of two Shot Programs, one Transition Asset, and shared Transition Time.
- The Publication Pipeline captures fixed frames and encodes deliveries; it does not reinterpret direction.
- Story Publication preserves Director/Beat order, declared transitions, and fixed Scene Time. It may reframe a Delivery Profile, but it may not alter narrative state or substitute a Treatment.
- Keep sources and intermediates local by default. Ask before sending user material to any external service other than one explicitly requested by the user.

## Capability Honesty

Use only tools advertised by the active MCP server. If a workflow stage is not exposed yet, identify the missing stage instead of simulating a successful production run.
