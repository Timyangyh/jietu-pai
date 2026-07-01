import type { GeneratePortraitOutput, ImageProviderMode, QualityScore, StyleRecipe } from "./provider.types";

export type LocalJobStatus =
  | "created"
  | "queued"
  | "needs-manual-codex"
  | "running"
  | "succeeded"
  | "partial_succeeded"
  | "failed"
  | "retrying"
  | "dead_letter";

export interface LocalFileAsset {
  id: string;
  role: "reference" | "subject" | "output" | "recipe" | "prompt" | "review";
  fileName: string;
  relativePath: string;
  url?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  byteLength?: number;
  favorite?: boolean;
  deleted?: boolean;
}

export interface LocalGenerationJobManifest {
  schemaVersion: 1;
  jobId: string;
  providerMode: ImageProviderMode;
  status: LocalJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  durationMs?: number;
  count: number;
  maxRetries: number;
  retryCount?: number;
  title: string;
  rootDir: string;
  referenceImages: LocalFileAsset[];
  subjectImages: LocalFileAsset[];
  recipe: StyleRecipe;
  outputs: LocalFileAsset[];
  review?: Record<string, QualityScore>;
  error?: string;
}

export interface GalleryIndex {
  schemaVersion: 1;
  updatedAt: string;
  favorites: Record<string, boolean>;
  deleted: Record<string, boolean>;
  deletedJobs?: Record<string, boolean>;
}

export function toProviderOutput(manifest: LocalGenerationJobManifest): GeneratePortraitOutput {
  return {
    jobId: manifest.jobId,
    status: manifest.status === "created" ? "queued" : manifest.status,
    images: manifest.outputs.map((item) => ({
      id: item.id,
      pathOrUrl: item.url ?? item.relativePath,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(manifest.review?.[item.id] ? { score: manifest.review[item.id] } : {})
    })),
    ...(manifest.error ? { error: manifest.error } : {})
  };
}
