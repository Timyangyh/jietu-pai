import fs from "node:fs/promises";
import path from "node:path";
import type {
  ImageProvider,
  ImageProviderMode,
  LocalFileAsset,
  LocalGenerationJobManifest,
  LocalJobStatus,
  QualityScore,
  StyleHint,
  StyleRecipe
} from "@styleme/core";
import { buildRecipeFromHints, validateStyleRecipe } from "@styleme/core";
import { decodeImageInput, guessMimeFromFileName, readImageMeta, type ImageInputPayload } from "../lib/image";
import { readJsonFile, writeJsonFile } from "../lib/json";
import { fileUrl, localJobsRoot, projectRoot, relativeToProjectRoot } from "../lib/paths";

const ORPHANED_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVE_STATUSES = new Set<LocalJobStatus>(["queued", "running", "retrying"]);

export interface CreateLocalGenerationInput {
  jobId: string;
  providerMode: ImageProviderMode;
  reference: ImageInputPayload;
  subjects: ImageInputPayload[];
  source?: StyleHint;
  recipe?: StyleRecipe;
  count: number;
  maxRetries: number;
}

export async function createLocalGenerationJob(
  input: CreateLocalGenerationInput,
  provider: ImageProvider
): Promise<LocalGenerationJobManifest> {
  if (!input.subjects.length) throw new Error("At least one subject image is required");

  const jobDir = path.join(localJobsRoot, input.jobId);
  const inputDir = path.join(jobDir, "input");
  const outputDir = path.join(jobDir, "output");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const reference = await writeInputAsset(inputDir, "reference", 1, input.reference);
  const subjects = await Promise.all(
    input.subjects.map((subject, index) => writeInputAsset(inputDir, "subject", index + 1, subject))
  );
  const recipe =
    input.recipe && validateStyleRecipe(input.recipe)
      ? input.recipe
      : await analyzeRecipeForGeneration(input, reference, provider);

  await writeJsonFile(path.join(inputDir, "recipe.json"), recipe);
  const now = new Date().toISOString();
  const queuedManifest: LocalGenerationJobManifest = {
    schemaVersion: 1,
    jobId: input.jobId,
    providerMode: input.providerMode,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    count: input.count,
    maxRetries: input.maxRetries,
    retryCount: 0,
    title: recipe.title,
    rootDir: relativeToProjectRoot(jobDir),
    referenceImages: [reference],
    subjectImages: subjects,
    recipe,
    outputs: []
  };
  await writeManifest(jobDir, queuedManifest);
  await writeJsonFile(path.join(jobDir, "review.json"), {});
  return startLocalGenerationJob(queuedManifest, provider);
}

async function analyzeRecipeForGeneration(
  input: CreateLocalGenerationInput,
  reference: LocalFileAsset,
  provider: ImageProvider
): Promise<StyleRecipe> {
  const recipeId = `recipe_${input.jobId}`;
  if (input.providerMode === "mock" || input.providerMode === "codex-dev") {
    return buildRecipeFromHints(
      recipeId,
      reference,
      compactHint({
        ...input.source,
        fileName: input.reference.fileName,
        sourceUrl: input.reference.sourceUrl
      })
    );
  }

  const analyzedRecipe = await provider.analyzeStyle([path.join(projectRoot, reference.relativePath)]);
  return validateStyleRecipe(analyzedRecipe) ? analyzedRecipe : buildRecipeFromHints(recipeId, reference, {});
}

export async function retryLocalGenerationJob(
  jobId: string,
  provider: ImageProvider
): Promise<LocalGenerationJobManifest> {
  const manifest = await readLocalManifest(jobId);
  const retryCount = manifest.retryCount ?? 0;
  if (retryCount >= manifest.maxRetries) {
    const jobDir = path.join(localJobsRoot, jobId);
    const nextManifest: LocalGenerationJobManifest = {
      ...manifest,
      status: "dead_letter",
      updatedAt: new Date().toISOString(),
      error: `已达到最大重试次数 ${manifest.maxRetries}`
    };
    await writeManifest(jobDir, nextManifest);
    return nextManifest;
  }

  const jobDir = path.join(localJobsRoot, jobId);
  const { error: _previousError, ...manifestWithoutError } = manifest;
  const retryingManifest: LocalGenerationJobManifest = {
    ...manifestWithoutError,
    status: "retrying",
    retryCount: retryCount + 1,
    updatedAt: new Date().toISOString()
  };
  await writeManifest(jobDir, retryingManifest);
  return startLocalGenerationJob(retryingManifest, provider);
}

async function startLocalGenerationJob(
  manifest: LocalGenerationJobManifest,
  provider: ImageProvider
): Promise<LocalGenerationJobManifest> {
  const runningManifest = await markLocalGenerationRunning(manifest);
  void runLocalGenerationJob(runningManifest, provider).catch(async (error) => {
    await markLocalGenerationFailed(runningManifest, error);
  });
  return runningManifest;
}

export async function runLocalGenerationJob(
  manifest: LocalGenerationJobManifest,
  provider: ImageProvider
): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(localJobsRoot, manifest.jobId);
  const outputDir = path.join(jobDir, "output");
  const runningManifest = manifest.status === "running" ? manifest : await markLocalGenerationRunning(manifest);
  const startedAt = runningManifest.startedAt ?? new Date().toISOString();

  try {
    const result = await provider.generatePortraits({
      jobId: manifest.jobId,
      mode: manifest.providerMode,
      referenceImagePathOrUrls: manifest.referenceImages.map((asset) => path.join(projectRoot, asset.relativePath)),
      subjectImagePathOrUrls: manifest.subjectImages.map((asset) => path.join(projectRoot, asset.relativePath)),
      recipe: manifest.recipe,
      count: manifest.count,
      maxRetries: manifest.maxRetries,
      outputDirectory: outputDir
    });

    const refreshed = await refreshLocalManifestOutputs(runningManifest);
    const nextStatus =
      result.status === "failed" && refreshed.outputs.length === 0
        ? "failed"
        : refreshed.outputs.length >= manifest.count
          ? "succeeded"
          : refreshed.outputs.length > 0
            ? "partial_succeeded"
            : result.status === "running" || result.status === "queued" || result.status === "retrying"
              ? "failed"
              : result.status;

    const finishedAt = new Date().toISOString();
    const nextManifest: LocalGenerationJobManifest = {
      ...refreshed,
      status: nextStatus,
      finishedAt,
      updatedAt: finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      ...(result.error
        ? { error: result.error }
        : nextStatus === "failed"
          ? { error: "Provider 未返回输出图片。" }
          : {})
    };
    await writeManifest(jobDir, nextManifest);
    await ensureReviewFile(nextManifest);
    return nextManifest;
  } catch (error) {
    return markLocalGenerationFailed(runningManifest, error);
  }
}

async function markLocalGenerationRunning(manifest: LocalGenerationJobManifest): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(localJobsRoot, manifest.jobId);
  const {
    error: _previousError,
    finishedAt: _previousFinishedAt,
    durationMs: _previousDurationMs,
    ...manifestWithoutError
  } = manifest;
  const startedAt = new Date().toISOString();
  const runningManifest: LocalGenerationJobManifest = {
    ...manifestWithoutError,
    status: "running",
    startedAt,
    updatedAt: startedAt
  };
  await writeManifest(jobDir, runningManifest);
  return runningManifest;
}

async function markLocalGenerationFailed(
  manifest: LocalGenerationJobManifest,
  error: unknown
): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(localJobsRoot, manifest.jobId);
  const refreshed = await refreshLocalManifestOutputs(manifest);
  if (refreshed.outputs.length > 0) return refreshed;
  const finishedAt = new Date().toISOString();
  const durationMs = manifest.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(manifest.startedAt)) : undefined;
  const nextManifest: LocalGenerationJobManifest = {
    ...refreshed,
    status: "failed",
    finishedAt,
    updatedAt: finishedAt,
    error: error instanceof Error ? error.message : String(error),
    ...(durationMs !== undefined ? { durationMs } : {})
  };
  await writeManifest(jobDir, nextManifest);
  await ensureReviewFile(nextManifest);
  return nextManifest;
}

export async function readLocalManifest(jobId: string): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(localJobsRoot, jobId);
  const manifest = await readJsonFile<LocalGenerationJobManifest | undefined>(
    path.join(jobDir, "manifest.json"),
    undefined
  );
  if (!manifest) throw new Error(`Generation not found: ${jobId}`);
  return refreshLocalManifestOutputs(manifest);
}

export async function listLocalManifests(): Promise<LocalGenerationJobManifest[]> {
  try {
    const entries = await fs.readdir(localJobsRoot, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await readLocalManifest(entry.name);
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

export async function refreshLocalManifestOutputs(
  manifest: LocalGenerationJobManifest
): Promise<LocalGenerationJobManifest> {
  const jobDir = path.join(localJobsRoot, manifest.jobId);
  const outputDir = path.join(jobDir, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const files = await fs.readdir(outputDir);
  const outputs = await Promise.all(
    files
      .filter((fileName) => /\.(png|jpe?g|webp)$/i.test(fileName))
      .sort()
      .map(async (fileName) => {
        const absolutePath = path.join(outputDir, fileName);
        const relativePath = relativeToProjectRoot(absolutePath);
        const buffer = await fs.readFile(absolutePath);
        const mimeType = guessMimeFromFileName(fileName);
        const meta = readImageMeta(buffer, mimeType);
        const stat = await fs.stat(absolutePath);
        return {
          id: path.parse(fileName).name,
          role: "output" as const,
          fileName,
          relativePath,
          url: fileUrl(relativePath),
          mimeType,
          byteLength: stat.size,
          ...(meta.width ? { width: meta.width } : {}),
          ...(meta.height ? { height: meta.height } : {})
        };
      })
  );

  const review = await readJsonFile<Record<string, QualityScore> | undefined>(
    path.join(jobDir, "review.json"),
    undefined
  );
  const orphanedError = buildOrphanedJobError(manifest, outputs.length);
  const nextStatus =
    outputs.length >= manifest.count
      ? "succeeded"
      : outputs.length > 0
        ? "partial_succeeded"
        : orphanedError
          ? "failed"
          : manifest.status;
  const outputsChanged = JSON.stringify(outputs) !== JSON.stringify(manifest.outputs);
  const statusChanged = nextStatus !== manifest.status;
  const reviewChanged = JSON.stringify(review ?? undefined) !== JSON.stringify(manifest.review ?? undefined);
  const now = new Date().toISOString();
  const shouldFinalize =
    !manifest.finishedAt &&
    (nextStatus === "succeeded" || nextStatus === "partial_succeeded" || nextStatus === "failed");
  const durationMs =
    shouldFinalize && manifest.startedAt ? Math.max(0, Date.parse(now) - Date.parse(manifest.startedAt)) : undefined;

  const nextManifest: LocalGenerationJobManifest = {
    ...manifest,
    status: nextStatus,
    updatedAt: outputsChanged || statusChanged || reviewChanged || shouldFinalize ? now : manifest.updatedAt,
    outputs,
    ...(shouldFinalize ? { finishedAt: now } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(orphanedError
      ? {
          error: manifest.error ?? orphanedError,
          finishedAt: manifest.finishedAt ?? now
        }
      : {}),
    ...(review ? { review } : {})
  };
  if (outputsChanged || statusChanged || reviewChanged || shouldFinalize) {
    await writeManifest(jobDir, nextManifest);
  }
  return nextManifest;
}

function buildOrphanedJobError(manifest: LocalGenerationJobManifest, outputCount: number): string | undefined {
  if (outputCount > 0 || !ACTIVE_STATUSES.has(manifest.status)) return undefined;
  const referenceTime = Date.parse(manifest.startedAt ?? manifest.updatedAt);
  if (!Number.isFinite(referenceTime)) return undefined;
  if (Date.now() - referenceTime < ORPHANED_JOB_TIMEOUT_MS) return undefined;
  return "任务超过 15 分钟没有输出，可能是本地服务重启、插件请求中断或第三方 API 长时间无响应。请重试或切换生图 API。";
}

export async function saveLocalReview(
  jobId: string,
  scores: Record<string, QualityScore>
): Promise<LocalGenerationJobManifest> {
  const manifest = await readLocalManifest(jobId);
  const jobDir = path.join(localJobsRoot, jobId);
  const nextManifest: LocalGenerationJobManifest = {
    ...manifest,
    review: scores,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(path.join(jobDir, "review.json"), scores);
  await writeManifest(jobDir, nextManifest);
  return nextManifest;
}

export async function writeManifest(jobDir: string, manifest: LocalGenerationJobManifest): Promise<void> {
  await writeJsonFile(path.join(jobDir, "manifest.json"), manifest);
}

async function writeInputAsset(
  inputDir: string,
  role: "reference" | "subject",
  index: number,
  payload: ImageInputPayload
): Promise<LocalFileAsset> {
  const decoded = await decodeImageInput(payload);
  const suffix = role === "reference" ? "" : `-${String(index).padStart(2, "0")}`;
  const fileName = `${role}${suffix}${decoded.extension}`;
  const absolutePath = path.join(inputDir, fileName);
  await fs.writeFile(absolutePath, decoded.buffer);
  const relativePath = relativeToProjectRoot(absolutePath);
  return {
    id: `${role}${suffix || "-01"}`,
    role,
    fileName,
    relativePath,
    url: fileUrl(relativePath),
    mimeType: decoded.mimeType,
    byteLength: decoded.byteLength,
    ...(decoded.meta.width ? { width: decoded.meta.width } : {}),
    ...(decoded.meta.height ? { height: decoded.meta.height } : {})
  };
}

async function ensureReviewFile(manifest: LocalGenerationJobManifest): Promise<void> {
  const jobDir = path.join(localJobsRoot, manifest.jobId);
  const reviewPath = path.join(jobDir, "review.json");
  const existing = await readJsonFile<Record<string, QualityScore> | undefined>(reviewPath, undefined);
  if (existing && Object.keys(existing).length > 0) return;
  const review: Record<string, QualityScore> = Object.fromEntries(
    manifest.outputs.map((output) => [
      output.id,
      {
        risk: "unknown" as const,
        failureReasons: [],
        notes:
          manifest.providerMode === "mock"
            ? "Mock 占位图，只验证一键流程。"
            : "API 候选路线输出，待人工评分。"
      }
    ])
  );
  await writeJsonFile(reviewPath, review);
  await writeManifest(jobDir, {
    ...manifest,
    review
  });
}

type LooseStyleHint = {
  [K in keyof StyleHint]?: string | undefined;
};

function compactHint(value: LooseStyleHint): StyleHint {
  return {
    ...(value.altText ? { altText: value.altText } : {}),
    ...(value.fileName ? { fileName: value.fileName } : {}),
    ...(value.pageTitle ? { pageTitle: value.pageTitle } : {}),
    ...(value.pageUrl ? { pageUrl: value.pageUrl } : {}),
    ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {})
  };
}
