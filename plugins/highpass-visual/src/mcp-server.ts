import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  CompileDirectorProjectRequestSchema,
  CompileDirectorProjectToolOutputSchema,
  DirectorCompilerError,
  compileDirectorProjectFile,
  type DirectorCompiler
} from "./director-compiler.js";

import {
  inspectRuntime,
  RuntimeToolOutputSchema,
  systemCommandProbe,
  type CommandProbe,
  type RuntimeInspectionOptions
} from "./runtime-inspection.js";
import {
  CompileVisionAssetRequestSchema,
  CompileVisionAssetToolOutputSchema,
  VisionCompilerError,
  compileVisionAsset,
  type VisionCompiler
} from "./vision-compiler.js";
import {
  PrepareInkRevealPreviewRequestSchema,
  PrepareInkRevealPreviewToolOutputSchema,
  PrepareTreatmentComparisonRequestSchema,
  PrepareTreatmentComparisonToolOutputSchema,
  prepareInkRevealPreview,
  prepareTreatmentComparison,
  type ComparisonBuilder,
  type PreviewBuilder
} from "./preview-builder.js";
import {
  PublishShotRequestSchema,
  PublishShotToolOutputSchema,
  PublicationError,
  publishShot,
  type Publisher
} from "./publication-pipeline.js";
import {
  PublishStoryRequestSchema,
  PublishStoryToolOutputSchema,
  StoryPublicationError,
  publishStory,
  type StoryPublisher
} from "./story-publication.js";
import {
  CompileTransitionAssetRequestSchema,
  CompileTransitionAssetToolOutputSchema,
  TransitionCompilerError,
  compileTransitionAsset,
  type TransitionCompiler
} from "./transition-compiler.js";
import {
  PrepareTransitionProgramRequestSchema,
  PrepareTransitionProgramToolOutputSchema,
  prepareTransitionProgram,
  type TransitionPreviewBuilder
} from "./transition-preview-builder.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
const artifactWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export type McpServerOptions = {
  runtimeProbe?: CommandProbe;
  runtimeOptions?: RuntimeInspectionOptions;
  directorCompiler?: DirectorCompiler;
  visionCompiler?: VisionCompiler;
  transitionCompiler?: TransitionCompiler;
  previewBuilder?: PreviewBuilder;
  comparisonBuilder?: ComparisonBuilder;
  transitionPreviewBuilder?: TransitionPreviewBuilder;
  publisher?: Publisher;
  storyPublisher?: StoryPublisher;
};

function toolResult<T>(value: T) {
  const structuredContent = { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

function visionCompilerErrorResult(error: unknown) {
  const safe = error instanceof VisionCompilerError
    ? { code: error.code, message: error.message }
    : {
        code: "COMPILATION_FAILED",
        message: "Vision Asset compilation failed. Verify the Selected Image and recipe, then retry."
      };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }]
  };
}

export function createMcpServer(options: McpServerOptions = {}) {
  const server = new McpServer({ name: "highpass-visual", version: "0.2.0" });

  server.registerTool(
    "inspect_runtime",
    {
      title: "Inspect Highpass Visual runtime",
      description: "Report whether Node.js, Python, OpenCV, OpenCV ximgproc, FFmpeg, and deterministic browser capture are available. This tool never installs or changes the runtime.",
      inputSchema: {},
      outputSchema: RuntimeToolOutputSchema.shape,
      annotations: readOnly
    },
    async () => toolResult(await inspectRuntime(
      options.runtimeProbe ?? systemCommandProbe,
      options.runtimeOptions
    ))
  );

  server.registerTool(
    "prepare_treatment_comparison",
    {
      title: "Prepare a three-Treatment comparison",
      description: "Build Ink Reveal, Memory Focus, and Etched Light candidates with one narrative identity, seed, viewport, duration, probe schedule, Shot Sampler, and Canvas renderer.",
      inputSchema: PrepareTreatmentComparisonRequestSchema.shape,
      outputSchema: PrepareTreatmentComparisonToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.comparisonBuilder ?? prepareTreatmentComparison)(request));
      } catch {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: {
              code: "TREATMENT_COMPARISON_FAILED",
              message: "The Treatment comparison could not be prepared. Verify controls, narrative bindings, and required Vision Asset channels."
            } })
          }]
        };
      }
    }
  );

  server.registerTool(
    "compile_vision_asset",
    {
      title: "Compile a Selected Image",
      description: "Compile one Selected Image and typed recipe into a cached, content-addressed Vision Asset. Returns only the manifest path and cache summary; raster and geometry payloads remain on disk.",
      inputSchema: CompileVisionAssetRequestSchema.shape,
      outputSchema: CompileVisionAssetToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.visionCompiler ?? compileVisionAsset)(request));
      } catch (error) {
        return visionCompilerErrorResult(error);
      }
    }
  );

  server.registerTool(
    "compile_transition_asset",
    {
      title: "Compile an adjacent Shot pair",
      description: "Analyze two adjacent Vision Assets with ORB/RANSAC, bidirectional optical flow, occlusion confidence, Distance Fields, and contour correspondence; select a quality-gated transition method and return its content-addressed manifest path.",
      inputSchema: CompileTransitionAssetRequestSchema.shape,
      outputSchema: CompileTransitionAssetToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.transitionCompiler ?? compileTransitionAsset)(request));
      } catch (error) {
        const safe = error instanceof TransitionCompilerError
          ? { code: error.code, message: error.message }
          : { code: "TRANSITION_COMPILATION_FAILED", message: "The adjacent Shot pair could not be compiled into a Transition Asset." };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }] };
      }
    }
  );

  server.registerTool(
    "compile_director_project",
    {
      title: "Compile director artifacts",
      description: "Validate a Skill-authored Director Project draft, verify accepted Image Candidate bytes, and write a content-addressed Story Model, Beats, Shots, image contracts, selections, and Shot Program plans.",
      inputSchema: CompileDirectorProjectRequestSchema.shape,
      outputSchema: CompileDirectorProjectToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.directorCompiler ?? compileDirectorProjectFile)(request));
      } catch (error) {
        const safe = error instanceof DirectorCompilerError
          ? { code: error.code, message: error.message }
          : error instanceof z.ZodError
            ? {
                code: "DIRECTOR_SCHEMA_INVALID",
                message: "Director Project schema validation failed.",
                issues: error.issues.slice(0, 12).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
              }
            : { code: "DIRECTOR_PROJECT_INVALID", message: "Director Project compilation failed. Repair schema, references, ordering, selections, or content hashes." };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }] };
      }
    }
  );

  server.registerTool(
    "prepare_ink_reveal_preview",
    {
      title: "Prepare an Ink Reveal preview",
      description: "Bind a Shot and Vision Asset into a validated absolute-time Ink Reveal Shot Program and a self-contained interactive Canvas preview. Returns file paths only.",
      inputSchema: PrepareInkRevealPreviewRequestSchema.shape,
      outputSchema: PrepareInkRevealPreviewToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.previewBuilder ?? prepareInkRevealPreview)(request));
      } catch {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code: "PREVIEW_BUILD_FAILED",
                message: "The Ink Reveal preview could not be prepared. Verify the Vision Asset manifest and output directory."
              }
            })
          }]
        };
      }
    }
  );

  server.registerTool(
    "prepare_transition_program",
    {
      title: "Prepare a pairwise Transition Program",
      description: "Bind two selected Shot Programs and one quality-gated Transition Asset into a shared-time deterministic transition preview supporting cross dissolve, Distance Field wipe, Homography, optical flow, and contour morph.",
      inputSchema: PrepareTransitionProgramRequestSchema.shape,
      outputSchema: PrepareTransitionProgramToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.transitionPreviewBuilder ?? prepareTransitionProgram)(request));
      } catch {
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: {
          code: "TRANSITION_PROGRAM_PREPARATION_FAILED",
          message: "The Transition Program could not be prepared. Verify adjacent Shot Programs, previews, and Transition Asset bindings."
        } }) }] };
      }
    }
  );

  server.registerTool(
    "publish_shot",
    {
      title: "Publish an exact-frame Shot",
      description: "Capture frame n at absolute Scene Time n/fps, resume valid lossless frames, encode an opaque H.264 MP4, inspect it, and return Delivery and Quality Evidence paths.",
      inputSchema: PublishShotRequestSchema.shape,
      outputSchema: PublishShotToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.publisher ?? publishShot)(request));
      } catch (error) {
        const safe = error instanceof PublicationError
          ? { code: error.code, message: error.message }
          : {
              code: "PUBLICATION_FAILED",
              message: "Shot publication failed. Lossless frames and existing Quality Evidence were left intact."
            };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }]
        };
      }
    }
  );

  server.registerTool(
    "publish_story",
    {
      title: "Publish a directed multi-Shot Story",
      description: "Validate Director-to-Shot bindings, publish and locally repair each exact-frame Shot, preserve canonical Beat order and transitions, mux optional existing audio and subtitles, inspect the final MP4, and write project-level Quality Evidence.",
      inputSchema: PublishStoryRequestSchema.shape,
      outputSchema: PublishStoryToolOutputSchema.shape,
      annotations: artifactWrite
    },
    async (request) => {
      try {
        return toolResult(await (options.storyPublisher ?? publishStory)(request));
      } catch (error) {
        const safe = error instanceof StoryPublicationError || error instanceof PublicationError
          ? { code: error.code, message: error.message }
          : {
              code: "STORY_PUBLICATION_FAILED",
              message: "Story publication failed. Completed Vision Assets, Shot Programs, and lossless Shot frames were left intact."
            };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }]
        };
      }
    }
  );

  return server;
}
