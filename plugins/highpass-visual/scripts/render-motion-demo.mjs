import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const sourceDraftPath = path.resolve(process.argv[2] ?? path.join(repositoryRoot, "outputs/the-last-lantern/source/director-draft.json"));
const outputRoot = path.resolve(process.argv[3] ?? path.join(repositoryRoot, "outputs/the-last-lantern-motion"));
const sourceDraftDirectory = path.dirname(sourceDraftPath);
const sourceDraft = JSON.parse(await readFile(sourceDraftPath, "utf8"));

sourceDraft.projectId = "the-last-lantern-motion-demo";
sourceDraft.brief.targetDuration = 16;
sourceDraft.shots[0].transitionOut = {
  intent: "continuity",
  duration: 1,
  reason: "Carry the paper boat, lantern, and central tower axis through one shared story-time overlap."
};
sourceDraft.shots[1].transitionOut = {
  intent: "reveal",
  duration: 1,
  reason: "Let the dark threshold open into the dawn skyline through the strongest verified shape transition."
};
sourceDraft.shots[2].transitionOut = {
  intent: "terminal",
  duration: 0,
  lockedMethod: "cut",
  reason: "The shared dawn remains the final held observation."
};
if (sourceDraft.sourceMaterial.provenance.kind === "local-file") {
  sourceDraft.sourceMaterial.provenance.sourcePath = path.resolve(sourceDraftDirectory, sourceDraft.sourceMaterial.provenance.sourcePath);
}
for (const candidate of sourceDraft.imageCandidates) {
  candidate.path = path.resolve(sourceDraftDirectory, candidate.path);
  if (candidate.origin.kind === "import") candidate.origin.sourcePath = candidate.path;
}
for (const selection of sourceDraft.selections) {
  selection.selectedImage.path = path.resolve(sourceDraftDirectory, selection.selectedImage.path);
}

const generatedDraftPath = path.join(outputRoot, "source", "director-draft.json");
await mkdir(path.dirname(generatedDraftPath), { recursive: true });
await writeFile(generatedDraftPath, `${JSON.stringify(sourceDraft, null, 2)}\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/mcp-server.cjs"],
  cwd: pluginRoot,
  stderr: "inherit"
});
const client = new Client({ name: "highpass-motion-demo", version: "0.2.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  if (result.isError || !result.structuredContent?.result) {
    const detail = result.content?.map((entry) => entry.type === "text" ? entry.text : "").filter(Boolean).join("\n");
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.structuredContent.result;
}

try {
  await client.connect(transport);
  const runtime = await call("inspect_runtime", {});
  if (runtime.status === "blocked") throw new Error(`Runtime blocked: ${runtime.blockers.join(" ")}`);
  const directed = await call("compile_director_project", {
    draftPath: generatedDraftPath,
    outputRoot: path.join(outputRoot, "artifacts", "director")
  });
  const project = JSON.parse(await readFile(directed.projectPath, "utf8"));
  const shots = [];
  const visions = [];
  for (const shot of project.shots) {
    const selection = project.selections.find((entry) => entry.shotId === shot.id);
    const plan = project.shotProgramPlans.find((entry) => entry.shotId === shot.id);
    const vision = await call("compile_vision_asset", {
      selectedImage: selection.selectedImage,
      recipe: plan.visionRecipe,
      artifactRoot: path.join(outputRoot, "artifacts", "vision", shot.id)
    });
    visions.push(vision);
    const comparison = await call("prepare_treatment_comparison", {
      shotId: shot.id,
      attentionTarget: shot.attentionTarget,
      duration: shot.duration,
      transitionOut: shot.transitionOut,
      directionHash: plan.directionHash,
      seed: plan.seed,
      visionAssetManifestPath: vision.manifestPath,
      outputDirectory: path.join(outputRoot, "previews", "shots", shot.id)
    });
    let selectedProgramPath = null;
    for (const candidatePath of comparison.candidateProgramPaths) {
      const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
      if (candidate.treatment.id === shot.treatmentId) selectedProgramPath = candidatePath;
    }
    if (!selectedProgramPath) throw new Error(`No ${shot.treatmentId} preview was prepared for ${shot.id}.`);
    shots.push({
      shotId: shot.id,
      shotProgramPath: selectedProgramPath,
      previewIndexPath: path.join(path.dirname(selectedProgramPath), "index.html")
    });
  }

  const transitions = [];
  const transitionDecisions = [];
  for (let index = 0; index < project.shots.length - 1; index += 1) {
    const outgoing = project.shots[index];
    const incoming = project.shots[index + 1];
    if (!["continuity", "reveal", "atmospheric"].includes(outgoing.transitionOut.intent) || outgoing.transitionOut.lockedMethod === "fade-to-black") continue;
    const asset = await call("compile_transition_asset", {
      outgoingVisionManifestPath: visions[index].manifestPath,
      incomingVisionManifestPath: visions[index + 1].manifestPath,
      transitionIntent: outgoing.transitionOut,
      artifactRoot: path.join(outputRoot, "artifacts", "transitions", `${outgoing.id}--${incoming.id}`)
    });
    const manifest = JSON.parse(await readFile(asset.manifestPath, "utf8"));
    const prepared = await call("prepare_transition_program", {
      outgoingShotProgramPath: shots[index].shotProgramPath,
      outgoingPreviewIndexPath: shots[index].previewIndexPath,
      incomingShotProgramPath: shots[index + 1].shotProgramPath,
      incomingPreviewIndexPath: shots[index + 1].previewIndexPath,
      transitionAssetManifestPath: asset.manifestPath,
      outputDirectory: path.join(outputRoot, "previews", "transitions", `${outgoing.id}--${incoming.id}`)
    });
    transitions.push({
      outgoingShotId: outgoing.id,
      incomingShotId: incoming.id,
      transitionProgramPath: prepared.transitionProgramPath,
      previewIndexPath: prepared.indexPath
    });
    transitionDecisions.push({
      outgoingShotId: outgoing.id,
      incomingShotId: incoming.id,
      intent: outgoing.transitionOut.intent,
      selectedMethod: manifest.plan.selectedMethod,
      selectionReason: manifest.plan.selectionReason,
      rejectedMethods: manifest.plan.rejectedMethods,
      metrics: manifest.metrics,
      warnings: manifest.warnings,
      transitionAssetManifestPath: asset.manifestPath,
      transitionProgramPath: prepared.transitionProgramPath
    });
  }

  const published = await call("publish_story", {
    directorProjectPath: directed.projectPath,
    shots,
    transitions,
    deliveryProfile: { id: "demo-720p", width: 1280, height: 720, fps: 24, codec: "h264", pixelFormat: "yuv420p" },
    outputRoot: path.join(outputRoot, "deliveries")
  });
  const evidence = JSON.parse(await readFile(published.qualityEvidencePath, "utf8"));
  const filmPath = path.join(outputRoot, "the-last-lantern-motion.mp4");
  const contactSheetPath = path.join(outputRoot, "the-last-lantern-motion-contact-sheet.png");
  await copyFile(published.mp4Path, filmPath);
  const contactSheet = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", filmPath,
    "-vf", "fps=1/2,scale=480:-1,tile=4x2:padding=8:margin=8:color=#0b0d12",
    "-frames:v", "1", contactSheetPath
  ], { encoding: "utf8" });
  if (contactSheet.status !== 0) throw new Error(`Contact sheet failed: ${contactSheet.stderr}`);
  const summary = {
    schemaVersion: "highpass.motion-demo-summary.v1",
    title: "The Last Lantern",
    runtime,
    directorProjectPath: directed.projectPath,
    filmPath,
    contactSheetPath,
    qualityEvidencePath: published.qualityEvidencePath,
    storyHash: published.storyHash,
    expectedFrameCount: published.expectedFrameCount,
    media: evidence.media,
    sceneRanges: evidence.sceneRanges,
    transitionDecisions,
    unresolvedWarnings: evidence.unresolvedWarnings
  };
  const summaryPath = path.join(outputRoot, "demo-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ filmPath, contactSheetPath, summaryPath, qualityEvidencePath: published.qualityEvidencePath, transitionDecisions }, null, 2));
} finally {
  await client.close();
}
