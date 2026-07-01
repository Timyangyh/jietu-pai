import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import type {
  GeneratePortraitInput,
  GeneratePortraitOutput,
  ImageProvider,
  QualityReviewInput,
  QualityReviewOutput,
  StyleRecipe
} from "@styleme/core";
import { buildRecipeFromHints } from "@styleme/core";

export class MockImageProvider implements ImageProvider {
  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    const sourceUrl = imagePathOrUrls[0];
    return buildRecipeFromHints(`recipe_mock_${Date.now()}`, {}, sourceUrl ? { sourceUrl } : {});
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    if (!input.outputDirectory) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: "Mock provider requires an output directory"
      };
    }

    await fs.mkdir(input.outputDirectory, { recursive: true });
    const size = sizeFromAspectRatio(input.recipe.generationParams.aspectRatio);
    const images = [];
    for (let index = 0; index < input.count; index += 1) {
      const fileName = `image-${String(index + 1).padStart(2, "0")}.png`;
      const outputPath = path.join(input.outputDirectory, fileName);
      const seed = `${input.jobId}:${index}:${input.recipe.title}:${input.referenceImagePathOrUrls.join(",")}`;
      await fs.writeFile(outputPath, createMockPng(size.width, size.height, seed));
      images.push({
        id: path.parse(fileName).name,
        pathOrUrl: outputPath,
        width: size.width,
        height: size.height
      });
    }

    return {
      jobId: input.jobId,
      status: "succeeded",
      images
    };
  }

  async reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput> {
    return {
      jobId: input.jobId,
      status: "needs_manual_review",
      scores: Object.fromEntries(
        input.outputImagePathOrUrls.map((item, index) => [
          path.parse(item).name || `image-${String(index + 1).padStart(2, "0")}`,
          {
            risk: "unknown",
            failureReasons: [],
            notes: "Mock 占位图，只验证流程，不评价保脸或风格。"
          }
        ])
      )
    };
  }
}

function sizeFromAspectRatio(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === "1:1") return { width: 1024, height: 1024 };
  if (aspectRatio === "3:4") return { width: 960, height: 1280 };
  if (aspectRatio === "9:16") return { width: 900, height: 1600 };
  return { width: 1024, height: 1280 };
}

function createMockPng(width: number, height: number, seed: string): Buffer {
  const digest = crypto.createHash("sha256").update(seed).digest();
  const c1 = [digest[0] ?? 30, digest[1] ?? 120, digest[2] ?? 96];
  const c2 = [digest[3] ?? 230, digest[4] ?? 190, digest[5] ?? 66];
  const c3 = [digest[6] ?? 245, digest[7] ?? 248, digest[8] ?? 250];
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + 1 + x * 4;
      const t = y / Math.max(1, height - 1);
      const wave = (Math.sin((x / width) * Math.PI * 4 + (digest[9] ?? 0)) + 1) / 2;
      const stripe = Math.floor((x / width) * 5) % 2 === 0 ? c2 : c3;
      raw[offset] = mix(mix(c1[0] ?? 0, stripe[0] ?? 0, wave * 0.35), c3[0] ?? 0, t * 0.28);
      raw[offset + 1] = mix(mix(c1[1] ?? 0, stripe[1] ?? 0, wave * 0.35), c3[1] ?? 0, t * 0.28);
      raw[offset + 2] = mix(mix(c1[2] ?? 0, stripe[2] ?? 0, wave * 0.35), c3[2] ?? 0, t * 0.28);
      raw[offset + 3] = 255;
    }
  }

  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a * (1 - t) + b * t);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
