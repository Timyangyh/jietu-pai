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
import { buildRecipeFromHints } from "@styleme/core";
import { buildGenerationPrompt } from "@styleme/prompts";
import { guessMimeFromFileName } from "../lib/image";

export class OpenAIImagesAdapter implements ImageProvider {
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-image-2";
  }

  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured in the local server environment");
    }
    const sourceUrl = imagePathOrUrls[0];
    return buildRecipeFromHints(`recipe_openai_${Date.now()}`, {}, sourceUrl ? { sourceUrl } : {});
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    if (!this.apiKey) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: "OPENAI_API_KEY 未配置。请在本地服务 .env 或 Provider 设置中配置 key。"
      };
    }
    if (!input.outputDirectory) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: "OpenAI provider requires an output directory"
      };
    }

    await fs.mkdir(input.outputDirectory, { recursive: true });

    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", buildGenerationPrompt(input));
    form.append("n", String(input.count));
    form.append("size", sizeForAspectRatio(input.recipe.generationParams.aspectRatio));
    form.append("quality", "medium");
    form.append("output_format", "png");

    for (const imagePath of [...input.referenceImagePathOrUrls, ...input.subjectImagePathOrUrls]) {
      const file = await readImageBlob(imagePath);
      form.append("image[]", file.blob, file.fileName);
    }

    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`
      },
      body: form
    });
    const body = (await response.json()) as OpenAIImagesResponse;
    if (!response.ok) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: body.error?.message ?? `OpenAI image generation failed: ${response.status}`
      };
    }

    const images = [];
    for (const [index, item] of (body.data ?? []).entries()) {
      const fileName = `image-${String(index + 1).padStart(2, "0")}.png`;
      const outputPath = path.join(input.outputDirectory, fileName);
      if (item.b64_json) {
        await fs.writeFile(outputPath, Buffer.from(item.b64_json, "base64"));
      } else if (item.url) {
        const imageResponse = await fetch(item.url);
        if (!imageResponse.ok) continue;
        await fs.writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
      } else {
        continue;
      }
      images.push({
        id: path.parse(fileName).name,
        pathOrUrl: outputPath
      });
    }

    if (images.length === 0) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: "OpenAI 返回成功响应，但没有可保存的图片。"
      };
    }

    return {
      jobId: input.jobId,
      status: images.length >= input.count ? "succeeded" : "partial_succeeded",
      images
    };
  }

  async reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput> {
    if (!this.apiKey) {
      return {
        jobId: input.jobId,
        status: "failed",
        scores: {},
        error: "OPENAI_API_KEY 未配置。"
      };
    }
    return {
      jobId: input.jobId,
      status: "needs_manual_review",
      scores: Object.fromEntries(
        input.outputImagePathOrUrls.map((item, index) => [
          path.parse(item).name || `image-${String(index + 1).padStart(2, "0")}`,
          {
            risk: "unknown",
            failureReasons: [],
            notes: "OpenAI API 输出，待人工评分。"
          }
        ])
      )
    };
  }
}

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
}

async function readImageBlob(imagePathOrUrl: string): Promise<{ blob: Blob; fileName: string }> {
  if (/^https?:\/\//.test(imagePathOrUrl)) {
    const response = await fetch(imagePathOrUrl);
    if (!response.ok) throw new Error(`Could not fetch image URL for OpenAI input: ${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
    return {
      blob: new Blob([await response.arrayBuffer()], { type: mimeType }),
      fileName: path.basename(new URL(imagePathOrUrl).pathname) || "image.png"
    };
  }

  const buffer = await fs.readFile(imagePathOrUrl);
  return {
    blob: new Blob([new Uint8Array(buffer)], { type: guessMimeFromFileName(imagePathOrUrl) }),
    fileName: path.basename(imagePathOrUrl)
  };
}

function sizeForAspectRatio(aspectRatio: string): string {
  if (aspectRatio === "1:1") return "1024x1024";
  return "1024x1536";
}
