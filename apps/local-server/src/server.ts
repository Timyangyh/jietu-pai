import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildRecipeFromHints,
  type GalleryIndex,
  type ImageProvider,
  type ImageProviderMode,
  type LocalFileAsset,
  type QualityScore,
  type StyleHint,
  type StyleRecipe,
  validateStyleRecipe
} from "@styleme/core";
import { loadProjectEnv } from "./lib/env";
import { decodeImageInput, guessMimeFromFileName, readImageMeta, type ImageInputPayload } from "./lib/image";
import { readJsonFile, writeJsonFile } from "./lib/json";
import {
  assertInsideProject,
  codexJobsRoot,
  fileUrl,
  localLibraryRoot,
  localJobsRoot,
  projectRoot,
  relativeToProjectRoot,
  runsRoot
} from "./lib/paths";
import { CodexAccountProvider } from "./providers/codexAccountProvider";
import {
  createCodexTaskPackage,
  listManifests as listCodexManifests,
  readManifest as readCodexManifest,
  refreshManifestOutputs,
  writeManifest as writeCodexManifest
} from "./providers/codexDevAdapter";
import { MockImageProvider } from "./providers/mockImageProvider";
import { OpenAIImagesAdapter } from "./providers/openAIImagesAdapter";
import { CompatibleImagesApiAdapter, GeminiImagesAdapter } from "./providers/thirdPartyImageProviders";
import {
  createLocalGenerationJob,
  listLocalManifests,
  readLocalManifest,
  retryLocalGenerationJob,
  saveLocalReview
} from "./services/localJobs";
import {
  getOpenAIApiKey,
  getOpenAIAnalysisModel,
  getOpenAIModel,
  getEffectiveThirdPartyProviderKey,
  getThirdPartyApiConfig,
  readProviderSettings,
  summarizeCurrentProviderSettings,
  updateProviderSettings,
  type ProviderSettingsUpdate,
  type RawProviderSettings
} from "./services/providerSettings";

const MAX_BODY_BYTES = 40 * 1024 * 1024;
const galleryPath = path.join(localLibraryRoot, "gallery.json");
const servableFileRoots = [
  path.join(localLibraryRoot, "references"),
  localJobsRoot,
  codexJobsRoot
].map((item) => path.resolve(item));
const servableImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

loadProjectEnv();

export interface CreateStyleMeServerOptions {
  port?: number;
}

interface AnalyzeRequest {
  reference: ImageInputPayload;
  source?: StyleHint;
  providerMode?: ImageProviderMode;
}

interface CreateJobRequest {
  reference: ImageInputPayload;
  subjects: ImageInputPayload[];
  source?: StyleHint;
  recipe?: StyleRecipe;
  count?: number;
  maxRetries?: number;
  providerMode?: ImageProviderMode;
}

interface ReviewRequest {
  scores: Record<string, QualityScore>;
}

interface ClearGalleryRequest {
  jobIds?: string[];
  providerMode?: ImageProviderMode;
}

export function createStyleMeServer(_options: CreateStyleMeServerOptions = {}): http.Server {
  return http.createServer(async (request, response) => {
    setCorsHeaders(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const result = await route(request, url);
      sendJson(response, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

async function route(request: IncomingMessage, url: URL): Promise<unknown> {
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    const settings = await readProviderSettings();
    const openaiKey = getOpenAIApiKey(settings);
    return {
      ok: true,
      projectRoot,
      runsRoot,
      hasOpenAIKey: Boolean(openaiKey.apiKey),
      activeProvider: settings.activeProvider,
      activeAnalysisProvider: settings.activeAnalysisProvider
    };
  }

  if (method === "GET" && url.pathname === "/v1/files") {
    const relativePath = url.searchParams.get("path");
    if (!relativePath) throw new HttpError(400, "Missing file path");
    return serveFile(relativePath);
  }

  if (method === "POST" && url.pathname === "/v1/recipes/analyze") {
    const body = await readJsonBody<AnalyzeRequest>(request);
    return analyzeReference(body);
  }

  if (method === "POST" && url.pathname === "/v1/jobs/codex") {
    const body = await readJsonBody<CreateJobRequest>(request);
    return createCodexJob(body);
  }

  if (method === "GET" && url.pathname === "/v1/settings/providers") {
    return summarizeCurrentProviderSettings();
  }

  if (method === "POST" && url.pathname === "/v1/settings/providers") {
    const body = await readJsonBody<ProviderSettingsUpdate>(request);
    return updateProviderSettings(body);
  }

  if (method === "POST" && url.pathname === "/v1/generations") {
    const body = await readJsonBody<CreateJobRequest>(request);
    return createGeneration(body);
  }

  const generationRetryMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)\/retry$/);
  if (method === "POST" && generationRetryMatch?.[1]) {
    return retryGeneration(generationRetryMatch[1]);
  }

  const generationReviewMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)\/review$/);
  if (method === "POST" && generationReviewMatch?.[1]) {
    const body = await readJsonBody<ReviewRequest>(request);
    return saveGenerationReview(generationReviewMatch[1], body);
  }

  const generationFavoriteMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)\/favorite$/);
  if (method === "POST" && generationFavoriteMatch?.[1]) {
    const body = await readJsonBody<{ imageId: string; favorite: boolean }>(request);
    return setFavorite(generationFavoriteMatch[1], body.imageId, body.favorite);
  }

  const generationDeleteMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)\/delete$/);
  if (method === "POST" && generationDeleteMatch?.[1]) {
    const body = await readJsonBody<{ imageId: string; deleted: boolean }>(request);
    return deleteGenerationOutput(generationDeleteMatch[1], body.imageId, body.deleted);
  }

  const generationDeleteJobMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)\/delete-job$/);
  if (method === "POST" && generationDeleteJobMatch?.[1]) {
    return deleteGenerationJob(generationDeleteJobMatch[1]);
  }

  const generationMatch = url.pathname.match(/^\/v1\/generations\/([^/]+)$/);
  if (method === "GET" && generationMatch?.[1]) {
    const gallery = await readGallery();
    return { ok: true, job: attachGalleryToJob(await readLocalManifest(generationMatch[1]), gallery) };
  }

  if (method === "GET" && url.pathname === "/v1/jobs") {
    const jobs = await listCodexManifests();
    const gallery = await readGallery();
    return {
      ok: true,
      jobs: jobs.map((job) => attachGalleryToJob(job, gallery))
    };
  }

  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch?.[1]) {
    const gallery = await readGallery();
    const manifest = await readCodexManifest(jobMatch[1]);
    return { ok: true, job: attachGalleryToJob(manifest, gallery) };
  }

  const refreshMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/refresh$/);
  if (method === "POST" && refreshMatch?.[1]) {
    const manifest = await readCodexManifest(refreshMatch[1]);
    return { ok: true, job: await refreshManifestOutputs(manifest) };
  }

  const reviewMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/review$/);
  if (method === "POST" && reviewMatch?.[1]) {
    const body = await readJsonBody<ReviewRequest>(request);
    return saveReview(reviewMatch[1], body);
  }

  const favoriteMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/favorite$/);
  if (method === "POST" && favoriteMatch?.[1]) {
    const body = await readJsonBody<{ imageId: string; favorite: boolean }>(request);
    return setFavorite(favoriteMatch[1], body.imageId, body.favorite);
  }

  const jobDeleteOutputMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/delete$/);
  if (method === "POST" && jobDeleteOutputMatch?.[1]) {
    const body = await readJsonBody<{ imageId: string; deleted: boolean }>(request);
    return deleteDebugJobOutput(jobDeleteOutputMatch[1], body.imageId, body.deleted);
  }

  const jobDeleteMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/delete-job$/);
  if (method === "POST" && jobDeleteMatch?.[1]) {
    return deleteDebugJob(jobDeleteMatch[1]);
  }

  if (method === "POST" && url.pathname === "/v1/gallery/clear") {
    const body = await readJsonBody<ClearGalleryRequest>(request);
    return clearGalleryHistory(body);
  }

  if (method === "GET" && url.pathname === "/v1/gallery") {
    return buildGalleryResponse();
  }

  if (method === "GET" && url.pathname === "/v1/adapters") {
    return summarizeCurrentProviderSettings();
  }

  throw new HttpError(404, `Route not found: ${method} ${url.pathname}`);
}

async function analyzeReference(body: AnalyzeRequest): Promise<unknown> {
  const decoded = await decodeImageInput(body.reference);
  const recipeId = `recipe_${decoded.hash.slice(0, 12)}`;

  await fs.mkdir(path.join(localLibraryRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(localLibraryRoot, "recipes"), { recursive: true });
  const referencePath = path.join(localLibraryRoot, "references", `${recipeId}${decoded.extension}`);
  await fs.writeFile(referencePath, decoded.buffer);

  const settings = await readProviderSettings();
  const providerMode = body.providerMode ?? settings.activeAnalysisProvider;
  const recipe =
    providerMode === "mock" || providerMode === "codex-dev"
      ? buildRecipeFromHints(
          recipeId,
          decoded.meta,
          compactHint({
            ...body.source,
            fileName: body.reference.fileName,
            sourceUrl: body.reference.sourceUrl
          })
        )
      : await createProvider(providerMode, settings, "analysis").analyzeStyle([referencePath]);
  if (!validateStyleRecipe(recipe)) {
    throw new HttpError(500, "Provider returned an invalid StyleRecipe");
  }

  await writeJsonFile(path.join(localLibraryRoot, "recipes", `${recipeId}.json`), recipe);

  const relativePath = relativeToProjectRoot(referencePath);
  return {
    ok: true,
    recipe,
    reference: {
      id: decoded.hash.slice(0, 12),
      role: "reference",
      fileName: path.basename(referencePath),
      relativePath,
      url: fileUrl(relativePath),
      ...decoded.meta
    }
  };
}

async function createCodexJob(body: CreateJobRequest): Promise<unknown> {
  if (!body.subjects?.length) {
    throw new HttpError(400, "At least one subject image is required");
  }
  const count = clampInteger(body.count ?? 4, 1, 4);
  const maxRetries = clampInteger(body.maxRetries ?? 0, 0, 3);
  const jobId = createJobId();
  const jobDir = path.join(codexJobsRoot, jobId);
  const inputDir = path.join(jobDir, "input");
  await fs.mkdir(inputDir, { recursive: true });

  const reference = await writeInputAsset(inputDir, "reference", 1, body.reference);
  const subjects = await Promise.all(
    body.subjects.map((subject, index) => writeInputAsset(inputDir, "subject", index + 1, subject))
  );

  const recipe = body.recipe && validateStyleRecipe(body.recipe)
    ? body.recipe
    : buildRecipeFromHints(`recipe_${jobId}`, reference, compactHint({
        ...body.source,
        fileName: body.reference.fileName,
        sourceUrl: body.reference.sourceUrl
      }));

  const manifest = await createCodexTaskPackage({
    jobId,
    referenceAssets: [reference],
    subjectAssets: subjects,
    recipe,
    count,
    maxRetries
  });

  return {
    ok: true,
    job: manifest,
    nextAction: "把 input/ 下的图片和 generation-prompt.md 交给 Codex 生成，再将输出图片保存到 output/。"
  };
}

async function createGeneration(body: CreateJobRequest): Promise<unknown> {
  if (!body.reference) {
    throw new HttpError(400, "Reference image is required");
  }
  if (!body.subjects?.length) {
    throw new HttpError(400, "At least one subject image is required");
  }

  const settings = await readProviderSettings();
  const providerMode = body.providerMode ?? settings.activeProvider;
  const provider = createProvider(providerMode, settings, "generation");
  const job = await createLocalGenerationJob(
    {
      jobId: createJobId(),
      providerMode,
      reference: body.reference,
      subjects: body.subjects,
      count: clampInteger(body.count ?? 4, 1, 4),
      maxRetries: clampInteger(body.maxRetries ?? 2, 0, 5),
      ...(body.source ? { source: body.source } : {}),
      ...(body.recipe ? { recipe: body.recipe } : {})
    },
    provider
  );

  return {
    ok: true,
    job
  };
}

async function retryGeneration(jobId: string): Promise<unknown> {
  const manifest = await readLocalManifest(jobId);
  const settings = await readProviderSettings();
  const provider = createProvider(manifest.providerMode, settings, "generation");
  return {
    ok: true,
    job: await retryLocalGenerationJob(jobId, provider)
  };
}

async function saveGenerationReview(jobId: string, body: ReviewRequest): Promise<unknown> {
  return {
    ok: true,
    job: await saveLocalReview(jobId, body.scores)
  };
}

function createProvider(
  mode: ImageProviderMode,
  settings: RawProviderSettings,
  usage: "generation" | "analysis" = "generation"
): ImageProvider {
  if (mode === "mock") return new MockImageProvider();
  if (mode === "openai-api") {
    const openaiKey = getOpenAIApiKey(settings);
    return new OpenAIImagesAdapter({
      model: getOpenAIModel(settings),
      analysisModel: getOpenAIAnalysisModel(settings),
      ...(openaiKey.apiKey ? { apiKey: openaiKey.apiKey } : {})
    });
  }
  if (mode === "codex-account") return new CodexAccountProvider();
  if (mode === "codex-dev") return createUnavailableProvider("Codex 调试模式只创建任务包，请使用高级调试入口。");
  const activeThirdParty = getEffectiveThirdPartyProviderKey(settings, usage);
  const config = getThirdPartyApiConfig(settings, activeThirdParty);
  if (activeThirdParty === "geminiNanoBanana") {
    return new GeminiImagesAdapter({
      baseUrl: config.baseUrl,
      model: config.model,
      analysisModel: config.analysisModel,
      ...(config.apiKey ? { apiKey: config.apiKey } : {})
    });
  }
  if (activeThirdParty === "openrouter") {
    return new CompatibleImagesApiAdapter({
      providerLabel: "OpenRouter",
      baseUrl: config.baseUrl,
      model: config.model,
      analysisModel: config.analysisModel,
      ...(config.apiKey ? { apiKey: config.apiKey } : {})
    });
  }
  return new CompatibleImagesApiAdapter({
    providerLabel: "自定义 API",
    baseUrl: config.baseUrl,
    model: config.model,
    analysisModel: config.analysisModel,
    ...(config.apiKey ? { apiKey: config.apiKey } : {})
  });
}

function createUnavailableProvider(message: string): ImageProvider {
  return {
    async analyzeStyle() {
      return buildRecipeFromHints(`recipe_unavailable_${Date.now()}`, {}, {});
    },
    async generatePortraits(input) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: message
      };
    },
    async reviewQuality(input) {
      return {
        jobId: input.jobId,
        status: "failed",
        scores: {},
        error: message
      };
    }
  };
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

async function saveReview(jobId: string, body: ReviewRequest): Promise<unknown> {
  const manifest = await readCodexManifest(jobId);
  const nextManifest = {
    ...manifest,
    review: body.scores,
    updatedAt: new Date().toISOString()
  };
  const jobDir = path.join(codexJobsRoot, jobId);
  await writeJsonFile(path.join(jobDir, "output", "review.json"), body.scores);
  await writeCodexManifest(jobDir, nextManifest);
  return { ok: true, job: nextManifest };
}

async function setFavorite(jobId: string, imageId: string, favorite: boolean): Promise<unknown> {
  const gallery = await readGallery();
  gallery.favorites[`${jobId}/${imageId}`] = favorite;
  gallery.updatedAt = new Date().toISOString();
  await writeJsonFile(galleryPath, gallery);
  return { ok: true, favorite };
}

async function setDeleted(jobId: string, imageId: string, deleted: boolean): Promise<unknown> {
  const gallery = await readGallery();
  gallery.deleted[`${jobId}/${imageId}`] = deleted;
  if (deleted) {
    delete gallery.favorites[`${jobId}/${imageId}`];
  }
  gallery.updatedAt = new Date().toISOString();
  await writeJsonFile(galleryPath, gallery);
  return { ok: true, deleted };
}

async function deleteGenerationOutput(jobId: string, imageId: string, deleted: boolean): Promise<unknown> {
  return setDeleted(jobId, imageId, deleted);
}

async function deleteGenerationJob(jobId: string): Promise<unknown> {
  return setDeletedJob(jobId, true);
}

async function deleteDebugJobOutput(jobId: string, imageId: string, deleted: boolean): Promise<unknown> {
  return setDeleted(jobId, imageId, deleted);
}

async function deleteDebugJob(jobId: string): Promise<unknown> {
  return setDeletedJob(jobId, true);
}

async function setDeletedJob(jobId: string, deleted: boolean): Promise<unknown> {
  const gallery = await readGallery();
  gallery.deletedJobs = gallery.deletedJobs ?? {};
  gallery.deletedJobs[jobId] = deleted;
  if (deleted) {
    for (const key of Object.keys(gallery.favorites)) {
      if (key.startsWith(`${jobId}/`)) delete gallery.favorites[key];
    }
  }
  gallery.updatedAt = new Date().toISOString();
  await writeJsonFile(galleryPath, gallery);
  return { ok: true, deleted };
}

async function clearGalleryHistory(body: ClearGalleryRequest): Promise<unknown> {
  const gallery = await readGallery();
  const localJobs = await listLocalManifests();
  const codexJobs = await listCodexManifests();
  const requestedJobIds = body.jobIds?.filter(Boolean);
  const requested = requestedJobIds?.length ? [...new Set(requestedJobIds)] : undefined;
  const allJobs = [...localJobs, ...codexJobs];
  const jobsById = new Map(allJobs.map((job) => [job.jobId, job]));
  const candidates: Array<{ jobId: string; outputs: LocalFileAsset[]; providerMode?: ImageProviderMode }> = requested
    ? requested
        .map((jobId) => {
          const job = jobsById.get(jobId);
          return job
            ? { jobId: job.jobId, outputs: job.outputs, providerMode: job.providerMode }
            : { jobId, outputs: [] };
        })
        .filter((job) => !body.providerMode || !job.providerMode || job.providerMode === body.providerMode)
    : allJobs
        .filter((job) => gallery.deletedJobs?.[job.jobId] !== true && (!body.providerMode || job.providerMode === body.providerMode))
        .map((job) => ({ jobId: job.jobId, outputs: job.outputs, providerMode: job.providerMode }));

  gallery.deletedJobs = gallery.deletedJobs ?? {};
  let deletedOutputs = 0;
  let deletedJobs = 0;
  for (const job of candidates) {
    if (gallery.deletedJobs[job.jobId] === true) continue;
    gallery.deletedJobs[job.jobId] = true;
    deletedJobs += 1;
    deletedOutputs += job.outputs.length;
    for (const key of Object.keys(gallery.favorites)) {
      if (key.startsWith(`${job.jobId}/`)) delete gallery.favorites[key];
    }
    for (const key of Object.keys(gallery.deleted)) {
      if (key.startsWith(`${job.jobId}/`)) delete gallery.deleted[key];
    }
  }

  gallery.updatedAt = new Date().toISOString();
  await writeJsonFile(galleryPath, gallery);
  return {
    ok: true,
    deletedJobs,
    deletedOutputs
  };
}

async function buildGalleryResponse(): Promise<unknown> {
  const localJobs = await listLocalManifests();
  const codexJobs = await listCodexManifests();
  const gallery = await readGallery();
  const jobs = [...localJobs, ...codexJobs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((job) => gallery.deletedJobs?.[job.jobId] !== true)
    .map((job) => attachGalleryToJob(job, gallery));
  return {
    ok: true,
    jobs,
    items: jobs.flatMap((job) =>
      job.outputs.map((output) => ({
        jobId: job.jobId,
        imageId: output.id,
        title: job.title,
        providerMode: job.providerMode,
        status: job.status,
        url: output.url,
        relativePath: output.relativePath,
        favorite: output.favorite === true
      }))
    )
  };
}

function attachGalleryToJob<T extends { jobId: string; outputs: LocalFileAsset[] }>(job: T, gallery: GalleryIndex): T {
  return {
    ...job,
    outputs: job.outputs
      .filter((output) => gallery.deleted[`${job.jobId}/${output.id}`] !== true)
      .map((output) => ({
        ...output,
        favorite: gallery.favorites[`${job.jobId}/${output.id}`] === true,
        deleted: false
      }))
  };
}

async function readGallery(): Promise<GalleryIndex> {
  return readJsonFile<GalleryIndex>(galleryPath, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    favorites: {},
    deleted: {},
    deletedJobs: {}
  });
}

async function serveFile(relativePath: string): Promise<unknown> {
  const absolutePath = resolveServableFilePath(relativePath);
  const buffer = await fs.readFile(absolutePath);
  const mimeType = guessMimeFromFileName(absolutePath);
  const meta = readImageMeta(buffer, mimeType);
  return new FileResponse(buffer, mimeType, meta);
}

function resolveServableFilePath(relativePath: string): string {
  const absolutePath = assertInsideProject(path.join(projectRoot, relativePath));
  const extension = path.extname(absolutePath).toLowerCase();
  if (!servableImageExtensions.has(extension)) {
    throw new HttpError(403, "File is not available through the local media endpoint");
  }

  const resolved = path.resolve(absolutePath);
  const isUnderAllowedRoot = servableFileRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!isUnderAllowedRoot) {
    throw new HttpError(403, "File is outside the local media library");
  }
  return resolved;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (value instanceof FileResponse) {
    response.writeHead(status, {
      "content-type": value.mimeType,
      "content-length": value.buffer.byteLength,
      "cache-control": "no-store"
    });
    response.end(value.buffer);
    return;
  }

  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && isAllowedCorsOrigin(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function isAllowedCorsOrigin(origin: string): boolean {
  return origin.startsWith("chrome-extension://");
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function createJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${stamp}_${crypto.randomBytes(3).toString("hex")}`;
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class FileResponse {
  constructor(
    readonly buffer: Buffer,
    readonly mimeType: string,
    readonly meta: unknown
  ) {}
}
