# Highpass Visual

Highpass Visual turns written source material and selected story images into deterministic, art-directed animated films. The domain separates narrative truth, compiled visual structure, timed presentation, and delivered media.

## Language

**Source Material**:
The story, article, or other written content from which a project is directed.
_Avoid_: Input text, prompt, copy

**Story Project**:
The complete body of narrative, image, vision, timing, evidence, and delivery artifacts for one film.
_Avoid_: Job, generation, workspace

**Story Model**:
The renderer-independent narrative truth containing characters, places, props, states, continuity constraints, and the intended emotional arc.
_Avoid_: Story bible, continuity bible, semantic model

**Beat**:
One meaningful narrative or emotional change that the audience should perceive.
_Avoid_: Animation step, keyframe, event

**Shot**:
The smallest independently directed and timed passage of the film, with one primary attention target and one visual proof or emotional purpose.
_Avoid_: Scene, slide, frame

**Image Candidate**:
A generated or imported image proposed for a Shot but not yet accepted as its visual source.
_Avoid_: Draft image, variation

**Selected Image**:
The accepted visual source for a Shot, locked by content hash before deterministic compilation begins.
_Avoid_: Final image, source image

**Vision Asset**:
The deterministic compiled representation of a Selected Image, containing frequency layers, masks, distance fields, paths, metadata, and provenance.
_Avoid_: Processed image, filter output, CV result

**Region Contour**:
A closed, hierarchical path derived from a region mask and suitable for fill, clipping, or silhouette drawing.
_Avoid_: Edge, outline path

**Open Stroke**:
An ordered, non-filling path derived from a continuous edge segment or skeleton and suitable for arc-length drawing.
_Avoid_: Contour, line fragment

**Frequency Layer**:
A raster channel representing a bounded range of image structure, such as a low-frequency base or signed high-frequency detail.
_Avoid_: Filter, pass

**Distance Field**:
A scalar raster channel describing distance from a region boundary and used for continuous reveal, erosion, expansion, or glow.
_Avoid_: Blur mask, feather

**Treatment**:
A reusable art-direction recipe that maps Vision Asset channels to color, motion, compositing, and restraint rules.
_Avoid_: Theme, filter preset, effect

**Shot Program**:
The absolute-time presentation contract binding a Shot, its Vision Asset, its Treatment, and its timed actions.
_Avoid_: Timeline file, animation config

**Transition Intent**:
The Director-authored narrative purpose for moving between two ordered Shots, with an optional locked transition method.
_Avoid_: Transition effect, algorithm choice, preset

**Transition Plan**:
The quality-gated decision binding an outgoing Shot, an incoming Shot, their Transition Intent, the selected method, and a deterministic fallback chain.
_Avoid_: Auto transition, transition settings

**Transition Asset**:
The deterministic pairwise visual structure compiled for two adjacent Shots, such as alignment, flow, occlusion, mask, contour correspondence, or depth layers.
_Avoid_: Transition cache, CV intermediates

**Transition Program**:
The absolute-time contract that combines two Shot Programs with one Transition Plan and its Transition Asset across their shared boundary.
_Avoid_: Crossfade config, transition clip, overlap timeline

**Preview Artifact**:
A generated browser renderer bound to its Program, embedded visual bytes, renderer runtime, and HTML content hash; it is a publication input rather than an interchangeable viewer.
_Avoid_: Demo page, arbitrary HTML, player shell

**Visual State**:
The complete renderer-independent state obtained by sampling a Shot Program at one Scene Time.
_Avoid_: Frame, render state

**Scene Time**:
The absolute, seekable time coordinate within a Shot Program.
_Avoid_: Delta time, playback time, render time

**Story Time**:
The absolute time coordinate of the delivered film after adjacent Shot Programs have been mapped through shared Transition Program overlaps.
_Avoid_: Global Scene Time, export time, concatenated time

**Delivery Profile**:
The target dimensions, frame rate, codec, pixel format, audio, and transparency requirements for an exported film.
_Avoid_: Export settings, render preset

**Delivery**:
The encoded film and exact frame, audio, subtitle, and provenance manifests produced against one Delivery Profile.
_Avoid_: Export, render output, video file

**Quality Evidence**:
Measured facts about compiled assets, sampled frames, motion, performance, and encoded media that support or reject a release decision.
_Avoid_: Score, QA notes, metrics
