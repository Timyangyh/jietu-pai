import fs from "node:fs/promises";
import path from "node:path";
import type {
  GeneratePortraitInput,
  GeneratePortraitOutput,
  ImageProvider,
  QualityReviewInput,
  QualityReviewOutput,
  StyleRecipe
} from "@styleme/core";
import { buildGenerationPrompt } from "@styleme/prompts";
import { analysisRequestTimeoutMs, fetchWithTimeout, imageRequestTimeoutMs } from "../lib/fetchWithTimeout";
import { extensionForMime, guessMimeFromFileName } from "../lib/image";
import { buildReferenceAnalysisPrompt, parseStyleRecipeText } from "./styleAnalysis";

const RASTER_OUTPUT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export class GeminiImagesAdapter implements ImageProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly analysisModel: string;

  constructor(options: { apiKey?: string; baseUrl?: string; model?: string; analysisModel?: string } = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl?.trim() || "https://generativelanguage.googleapis.com";
    this.model = options.model?.trim() || "gemini-2.5-flash-image";
    this.analysisModel = options.analysisModel?.trim() || "";
  }

  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    const recipeId = `recipe_gemini_${Date.now()}`;
    if (!this.apiKey) throw new Error("Gemini API key 未配置。");
    if (!this.analysisModel) throw new Error("Gemini 看图分析模型未配置。");
    try {
      const imagePathOrUrl = imagePathOrUrls[0];
      if (!imagePathOrUrl) throw new Error("Reference image is required.");
      const image = await readImageAsBase64(imagePathOrUrl);
      const response = await fetchWithTimeout(
        geminiGenerateContentEndpoint(this.baseUrl, this.analysisModel),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: buildReferenceAnalysisPrompt(recipeId) },
                  {
                    inline_data: {
                      mime_type: image.mimeType,
                      data: image.data
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json"
            }
          })
        },
        { timeoutMs: analysisRequestTimeoutMs(), label: "Gemini 原图分析" }
      );
      const body = (await response.json()) as GeminiGenerateContentResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      return parseStyleRecipeText(geminiText(body), recipeId);
    } catch (error) {
      throw new Error(`Gemini 原图分析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    if (!this.apiKey) return failed(input.jobId, "GEMINI_API_KEY 未配置。请在 Provider 设置中保存 Gemini key。");
    if (!input.outputDirectory) return failed(input.jobId, "Gemini provider requires an output directory");

    await fs.mkdir(input.outputDirectory, { recursive: true });
    const imageInputs = await Promise.all(
      [...input.referenceImagePathOrUrls, ...input.subjectImagePathOrUrls].map(toGeminiImageInput)
    );
    const images = [];
    let lastError: string | undefined;

    for (let requestIndex = 0; requestIndex < input.count && images.length < input.count; requestIndex += 1) {
      const response = await fetchWithTimeout(
        geminiInteractionsEndpoint(this.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({
            model: this.model,
            input: [{ type: "text", text: buildGenerationPrompt(input) }, ...imageInputs],
            response_format: {
              type: "image",
              mime_type: "image/png",
              aspect_ratio: input.recipe.generationParams.aspectRatio
            }
          })
        },
        { timeoutMs: imageRequestTimeoutMs(), label: "Gemini 生图" }
      );
      const body = (await response.json()) as GeminiInteractionResponse;
      if (!response.ok) {
        lastError = body.error?.message ?? `Gemini image generation failed: ${response.status}`;
        break;
      }

      const responseImages = geminiResponseImages(body);
      if (responseImages.length === 0) {
        lastError = "Gemini 返回成功响应，但没有可保存的图片。";
        break;
      }
      for (const item of responseImages) {
        if (images.length >= input.count) break;
        const saved = await saveBase64Image(item.data, item.mimeType, input.outputDirectory, images.length + 1);
        images.push(saved);
      }
    }

    return outputFromImages(input.jobId, input.count, images, lastError);
  }

  async reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput> {
    if (!this.apiKey) {
      return {
        jobId: input.jobId,
        status: "failed",
        scores: {},
        error: "GEMINI_API_KEY 未配置。"
      };
    }
    return manualReview(input, "Gemini Nano Banana 图片输出，待人工评分。");
  }
}

export class CompatibleImagesApiAdapter implements ImageProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly analysisModel: string;
  private readonly providerLabel: string;

  constructor(options: { apiKey?: string; baseUrl?: string; model?: string; analysisModel?: string; providerLabel: string }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl?.trim() ?? "";
    this.model = options.model?.trim() ?? "";
    this.analysisModel = options.analysisModel?.trim() || "";
    this.providerLabel = options.providerLabel;
  }

  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    const recipeId = `recipe_${slug(this.providerLabel)}_${Date.now()}`;
    if (!this.apiKey) throw new Error(`${this.providerLabel} API key 未配置。`);
    if (!this.baseUrl) throw new Error(`${this.providerLabel} baseUrl 未配置。`);
    if (!this.analysisModel) throw new Error(`${this.providerLabel} 分析模型未配置。`);
    try {
      const imagePathOrUrl = imagePathOrUrls[0];
      if (!imagePathOrUrl) throw new Error("Reference image is required.");
      const imageReference = await toImageUrlReference(imagePathOrUrl);
      const response = await fetchWithTimeout(
        chatCompletionsEndpoint(this.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "x-title": "StyleMe Local"
          },
          body: JSON.stringify({
            model: this.analysisModel,
            temperature: 0.2,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: buildReferenceAnalysisPrompt(recipeId)
                  },
                  imageReference
                ]
              }
            ]
          })
        },
        { timeoutMs: analysisRequestTimeoutMs(), label: `${this.providerLabel} 原图分析` }
      );
      const body = (await response.json()) as ChatCompletionsResponse;
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      return parseStyleRecipeText(chatMessageText(body), recipeId);
    } catch (error) {
      throw new Error(`${this.providerLabel} 原图分析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    if (!this.apiKey) return failed(input.jobId, `${this.providerLabel} API key 未配置。`);
    if (!this.baseUrl) return failed(input.jobId, `${this.providerLabel} baseUrl 未配置。`);
    if (!this.model) return failed(input.jobId, `${this.providerLabel} model 未配置。`);
    if (!input.outputDirectory) return failed(input.jobId, `${this.providerLabel} provider requires an output directory`);

    await fs.mkdir(input.outputDirectory, { recursive: true });

    const references = await Promise.all(
      [...input.referenceImagePathOrUrls, ...input.subjectImagePathOrUrls].map(toImageUrlReference)
    );
    const images = [];
    let lastError: string | undefined;

    for (let requestIndex = 0; requestIndex < input.count && images.length < input.count; requestIndex += 1) {
      const response = await fetchWithTimeout(
        imagesEndpoint(this.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "x-title": "StyleMe Local"
          },
          body: JSON.stringify({
            model: this.model,
            prompt: buildGenerationPrompt(input),
            aspect_ratio: input.recipe.generationParams.aspectRatio,
            output_format: "png",
            ...(references.length > 0 ? { input_references: references } : {})
          })
        },
        { timeoutMs: imageRequestTimeoutMs(), label: `${this.providerLabel} 生图` }
      );
      const body = (await response.json()) as CompatibleImagesResponse;
      if (!response.ok) {
        lastError = body.error?.message ?? `${this.providerLabel} image generation failed: ${response.status}`;
        break;
      }

      for (const item of body.data ?? []) {
        if (images.length >= input.count) break;
        const saved = await saveCompatibleImage(item, input.outputDirectory, images.length + 1);
        if (saved) images.push(saved);
      }
    }

    return outputFromImages(
      input.jobId,
      input.count,
      images,
      lastError ?? (images.length === 0 ? `${this.providerLabel} 返回成功响应，但没有可保存的图片。` : undefined)
    );
  }

  async reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput> {
    if (!this.apiKey) {
      return {
        jobId: input.jobId,
        status: "failed",
        scores: {},
        error: `${this.providerLabel} API key 未配置。`
      };
    }
    return manualReview(input, `${this.providerLabel} 图片输出，待人工评分。`);
  }
}

interface GeminiInteractionResponse {
  output_image?: {
    data?: string;
    mime_type?: string;
  };
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      data?: string;
      mime_type?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface CompatibleImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    media_type?: string;
  }>;
  error?: {
    message?: string;
  };
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

async function toGeminiImageInput(imagePathOrUrl: string): Promise<{
  type: "image";
  data: string;
  mime_type: string;
}> {
  const { data, mimeType } = await readImageAsBase64(imagePathOrUrl);
  return {
    type: "image",
    data,
    mime_type: mimeType
  };
}

async function toImageUrlReference(imagePathOrUrl: string): Promise<{
  type: "image_url";
  image_url: { url: string };
}> {
  if (/^https?:\/\//.test(imagePathOrUrl) || imagePathOrUrl.startsWith("data:image/")) {
    return {
      type: "image_url",
      image_url: { url: imagePathOrUrl }
    };
  }

  const { data, mimeType } = await readImageAsBase64(imagePathOrUrl);
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${data}`
    }
  };
}

async function readImageAsBase64(imagePathOrUrl: string): Promise<{ data: string; mimeType: string }> {
  if (imagePathOrUrl.startsWith("data:image/")) {
    const match = imagePathOrUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match?.[1] || !match?.[2]) throw new Error("Invalid image data URL");
    return { mimeType: match[1], data: match[2] };
  }
  if (/^https?:\/\//.test(imagePathOrUrl)) {
    const response = await fetchWithTimeout(
      imagePathOrUrl,
      {},
      { timeoutMs: analysisRequestTimeoutMs(), label: "读取远程输入图片" }
    );
    if (!response.ok) throw new Error(`Could not fetch image URL: ${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? guessMimeFromFileName(imagePathOrUrl);
    return {
      mimeType,
      data: Buffer.from(await response.arrayBuffer()).toString("base64")
    };
  }
  const mimeType = guessMimeFromFileName(imagePathOrUrl);
  const buffer = await fs.readFile(imagePathOrUrl);
  return {
    mimeType,
    data: buffer.toString("base64")
  };
}

function geminiResponseImages(body: GeminiInteractionResponse): Array<{ data: string; mimeType?: string }> {
  const fromSteps =
    body.steps
      ?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .filter((content) => content.type === "image" && content.data)
      .map((content) => ({
        data: content.data as string,
        ...(content.mime_type ? { mimeType: content.mime_type } : {})
      })) ?? [];
  if (fromSteps.length > 0) return fromSteps;
  if (body.output_image?.data) {
    return [
      {
        data: body.output_image.data,
        ...(body.output_image.mime_type ? { mimeType: body.output_image.mime_type } : {})
      }
    ];
  }
  return [];
}

function geminiText(body: GeminiGenerateContentResponse): string {
  return body.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text ?? "").join("\n") ?? "";
}

function chatMessageText(body: ChatCompletionsResponse): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("\n") ?? "";
}

async function saveCompatibleImage(
  item: NonNullable<CompatibleImagesResponse["data"]>[number],
  outputDirectory: string,
  index: number
): Promise<{ id: string; pathOrUrl: string } | undefined> {
  if (item.b64_json) {
    return saveBase64Image(item.b64_json, item.media_type, outputDirectory, index);
  }

  if (item.url) {
    const response = await fetchWithTimeout(item.url, {}, { timeoutMs: imageRequestTimeoutMs(), label: "下载生成图片" });
    if (!response.ok) return undefined;
    const mimeType = normalizeOutputMime(response.headers.get("content-type")?.split(";")[0]);
    if (!mimeType) return undefined;
    const fileName = `image-${String(index).padStart(2, "0")}${extensionForMime(mimeType, item.url)}`;
    const outputPath = path.join(outputDirectory, fileName);
    await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return {
      id: path.parse(fileName).name,
      pathOrUrl: outputPath
    };
  }

  return undefined;
}

async function saveBase64Image(
  data: string,
  rawMimeType: string | undefined,
  outputDirectory: string,
  index: number
): Promise<{ id: string; pathOrUrl: string }> {
  const mimeType = normalizeOutputMime(rawMimeType) ?? "image/png";
  const fileName = `image-${String(index).padStart(2, "0")}${extensionForMime(mimeType)}`;
  const outputPath = path.join(outputDirectory, fileName);
  await fs.writeFile(outputPath, Buffer.from(data, "base64"));
  return {
    id: path.parse(fileName).name,
    pathOrUrl: outputPath
  };
}

function outputFromImages(
  jobId: string,
  count: number,
  images: Array<{ id: string; pathOrUrl: string }>,
  error?: string
): GeneratePortraitOutput {
  if (images.length === 0) {
    return {
      jobId,
      status: "failed",
      images: [],
      ...(error ? { error } : {})
    };
  }
  return {
    jobId,
    status: images.length >= count ? "succeeded" : "partial_succeeded",
    images,
    ...(error ? { error } : {})
  };
}

function failed(jobId: string, error: string): GeneratePortraitOutput {
  return {
    jobId,
    status: "failed",
    images: [],
    error
  };
}

function manualReview(input: QualityReviewInput, notes: string): QualityReviewOutput {
  return {
    jobId: input.jobId,
    status: "needs_manual_review",
    scores: Object.fromEntries(
      input.outputImagePathOrUrls.map((item, index) => [
        path.parse(item).name || `image-${String(index + 1).padStart(2, "0")}`,
        {
          risk: "unknown",
          failureReasons: [],
          notes
        }
      ])
    )
  };
}

function normalizeOutputMime(mimeType?: string | null): string | undefined {
  const normalized = mimeType?.toLowerCase() || "image/png";
  if (!RASTER_OUTPUT_TYPES.has(normalized)) return undefined;
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function geminiInteractionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/interactions")) return normalized;
  if (/\/v\d+(beta|alpha)?$/.test(normalized)) return `${normalized}/interactions`;
  return `${normalized}/v1beta/interactions`;
}

function geminiGenerateContentEndpoint(baseUrl: string, model: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const encodedModel = encodeURIComponent(model);
  if (/\/v\d+(beta|alpha)?$/.test(normalized)) return `${normalized}/models/${encodedModel}:generateContent`;
  return `${normalized}/v1beta/models/${encodedModel}:generateContent`;
}

function imagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/images") ? normalized : `${normalized}/images`;
}

function chatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "provider";
}
