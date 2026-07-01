import crypto from "node:crypto";
import path from "node:path";
import type { ImageMeta } from "@styleme/core";

export interface DecodedImageInput {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  byteLength: number;
  hash: string;
  meta: ImageMeta;
}

export interface ImageInputPayload {
  dataUrl?: string;
  sourceUrl?: string;
  fileName?: string;
}

export async function decodeImageInput(input: ImageInputPayload): Promise<DecodedImageInput> {
  if (input.dataUrl) {
    const parsed = parseDataUrl(input.dataUrl);
    return buildDecoded(parsed.buffer, parsed.mimeType, input.fileName);
  }

  if (input.sourceUrl) {
    const response = await fetch(input.sourceUrl, {
      headers: {
        "user-agent": "StyleMeLocal/0.1"
      }
    });
    if (!response.ok) {
      throw new Error(`Could not fetch image URL: ${response.status}`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0] || guessMimeFromFileName(input.sourceUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    return buildDecoded(buffer, mimeType, input.fileName ?? input.sourceUrl);
  }

  throw new Error("Image input must include dataUrl or sourceUrl");
}

export function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match?.[1] || !match?.[2]) {
    throw new Error("Invalid image data URL");
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

export function extensionForMime(mimeType: string, fallbackFileName?: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  const fromName = fallbackFileName ? path.extname(fallbackFileName).toLowerCase() : "";
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(fromName) ? fromName : ".png";
}

export function guessMimeFromFileName(fileName: string): string {
  const ext = path.extname(fileName.split("?")[0] ?? fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

export function readImageMeta(buffer: Buffer, mimeType: string): ImageMeta {
  const png = readPngSize(buffer);
  if (png) return { ...png, mimeType, byteLength: buffer.byteLength };
  const jpg = readJpegSize(buffer);
  if (jpg) return { ...jpg, mimeType, byteLength: buffer.byteLength };
  const webp = readWebpSize(buffer);
  if (webp) return { ...webp, mimeType, byteLength: buffer.byteLength };
  return { mimeType, byteLength: buffer.byteLength };
}

function buildDecoded(buffer: Buffer, mimeType: string, fileName?: string): DecodedImageInput {
  const normalizedMime = mimeType.startsWith("image/") ? mimeType : guessMimeFromFileName(fileName ?? "");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const meta = readImageMeta(buffer, normalizedMime);
  return {
    buffer,
    mimeType: normalizedMime,
    extension: extensionForMime(normalizedMime, fileName),
    byteLength: buffer.byteLength,
    hash,
    meta
  };
}

function readPngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24) return undefined;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return undefined;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readJpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker && marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 30) return undefined;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return undefined;
  if (buffer.subarray(8, 12).toString("ascii") !== "WEBP") return undefined;
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21] ?? 0;
    const b1 = buffer[22] ?? 0;
    const b2 = buffer[23] ?? 0;
    const b3 = buffer[24] ?? 0;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }
  return undefined;
}
