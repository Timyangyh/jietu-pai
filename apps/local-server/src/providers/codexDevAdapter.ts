import fs from "node:fs/promises";
import path from "node:path";
import type {
  GeneratePortraitInput,
  GeneratePortraitOutput,
  ImageProvider,
  LocalFileAsset,
  LocalGenerationJobManifest,
  QualityReviewInput,
  QualityReviewOutput,
  StyleHint,
  StyleRecipe
} from "@styleme/core";
import { buildRecipeFromHints, toProviderOutput } from "@styleme/core";
import { buildGenerationPrompt, buildReviewPrompt } from "@styleme/prompts";
import { readJsonFile, writeJsonFile } from "../lib/json";
import { codexJobsRoot, fileUrl, relativeToProjectRoot } from "../lib/paths";

export interface CodexTaskPackageInput {
  jobId: string;
  referenceAssets: LocalFileAsset[];
  subjectAssets: LocalFileAsset[];
  recipe: StyleRecipe;
  count: number;
  maxRetries: number;
}

export class CodexDevAdapter implements ImageProvider {
  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    const sourceUrl = imagePathOrUrls[0];
    return buildRecipeFromHints(`recipe_${Date.now()}`, {}, sourceUrl ? { sourceUrl } : {});
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    return {
      jobId: input.jobId,
      status: "needs-manual-codex",
      images: []
    };
  }

  async reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput> {
    return {
      jobId: input.jobId,
      status: "needs_manual_review",
      scores: Object.fromEntries(
        input.outputImagePathOrUrls.map((item, index) => [
          `image-${String(index + 1).padStart(2, "0")}`,
          {
            risk: "unknown",
            failureReasons: [],
            notes: "待人工评分"
          }
        ])
      )
    };
  }
}

export async function createCodexTaskPackage(input: CodexTaskPackageInput): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(codexJobsRoot, input.jobId);
  const inputDir = path.join(jobDir, "input");
  const outputDir = path.join(jobDir, "output");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const referencePaths = input.referenceAssets.map((asset) => asset.relativePath);
  const subjectPaths = input.subjectAssets.map((asset) => asset.relativePath);
  const generationInput: GeneratePortraitInput = {
    jobId: input.jobId,
    mode: "codex-dev",
    referenceImagePathOrUrls: referencePaths,
    subjectImagePathOrUrls: subjectPaths,
    recipe: input.recipe,
    count: input.count,
    maxRetries: input.maxRetries
  };

  const reviewInput: QualityReviewInput = {
    jobId: input.jobId,
    referenceImagePathOrUrls: referencePaths,
    subjectImagePathOrUrls: subjectPaths,
    outputImagePathOrUrls: [],
    recipe: input.recipe
  };

  await writeJsonFile(path.join(inputDir, "recipe.json"), input.recipe);
  await fs.writeFile(path.join(inputDir, "generation-prompt.md"), buildGenerationPrompt(generationInput), "utf8");
  await fs.writeFile(path.join(inputDir, "review-prompt.md"), buildReviewPrompt(reviewInput), "utf8");

  const now = new Date().toISOString();
  const manifest: LocalGenerationJobManifest = {
    schemaVersion: 1,
    jobId: input.jobId,
    providerMode: "codex-dev",
    status: "needs-manual-codex",
    createdAt: now,
    updatedAt: now,
    count: input.count,
    maxRetries: input.maxRetries,
    title: input.recipe.title,
    rootDir: relativeToProjectRoot(jobDir),
    referenceImages: input.referenceAssets,
    subjectImages: input.subjectAssets,
    recipe: input.recipe,
    outputs: []
  };
  await writeManifest(jobDir, manifest);
  return manifest;
}

export async function readManifest(jobId: string): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(codexJobsRoot, jobId);
  const manifest = await readJsonFile<LocalGenerationJobManifest | undefined>(
    path.join(jobDir, "manifest.json"),
    undefined
  );
  if (!manifest) throw new Error(`Job not found: ${jobId}`);
  return refreshManifestOutputs(manifest);
}

export async function listManifests(): Promise<LocalGenerationJobManifest[]> {
  try {
    const entries = await fs.readdir(codexJobsRoot, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await readManifest(entry.name);
          } catch {
            return undefined;
          }
        })
    );
    return jobs.filter((job): job is LocalGenerationJobManifest => Boolean(job)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function refreshManifestOutputs(
  manifest: LocalGenerationJobManifest
): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(codexJobsRoot, manifest.jobId);
  const outputDir = path.join(jobDir, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const files = await fs.readdir(outputDir);
  const outputs = files
    .filter((fileName) => /\.(png|jpe?g|webp)$/i.test(fileName))
    .sort()
    .map((fileName) => {
      const relativePath = relativeToProjectRoot(path.join(outputDir, fileName));
      return {
        id: path.parse(fileName).name,
        role: "output" as const,
        fileName,
        relativePath,
        url: fileUrl(relativePath)
      };
    });

  const nextStatus =
    outputs.length >= manifest.count
      ? "succeeded"
      : outputs.length > 0
        ? "partial_succeeded"
        : manifest.status;
  const outputsChanged = JSON.stringify(outputs) !== JSON.stringify(manifest.outputs);
  const statusChanged = nextStatus !== manifest.status;

  const nextManifest: LocalGenerationJobManifest = {
    ...manifest,
    status: nextStatus,
    updatedAt: outputsChanged || statusChanged ? new Date().toISOString() : manifest.updatedAt,
    outputs
  };
  if (outputsChanged || statusChanged) {
    await writeManifest(jobDir, nextManifest);
  }
  return nextManifest;
}

export async function writeManifest(jobDir: string, manifest: LocalGenerationJobManifest): Promise<void> {
  await writeJsonFile(path.join(jobDir, "manifest.json"), manifest);
}

export function providerOutputFromManifest(manifest: LocalGenerationJobManifest): GeneratePortraitOutput {
  return toProviderOutput(manifest);
}
