export type ImageProviderMode = "mock" | "codex-dev" | "openai-api" | "codex-account" | "third-party";

export type AspectRatio = "1:1" | "3:4" | "4:5" | "9:16";

export interface GenerationParams {
  seed?: number;
  strength?: number;
  guidanceScale?: number;
  identityStrength?: number;
  styleStrength?: number;
  aspectRatio: AspectRatio;
  negativePrompt: string;
}

export interface StyleRecipe {
  id: string;
  title: string;
  subject: string;
  scene: string;
  lighting: string;
  composition: string;
  camera: string;
  color: string;
  outfit: string;
  mood: string;
  negativePrompt: string;
  promptZh: string;
  promptEn: string;
  tags: string[];
  generationParams: GenerationParams;
}

export interface QualityScore {
  styleScore?: number;
  identityScore?: number;
  qualityScore?: number;
  usabilityScore?: number;
  faceSimilarity?: number;
  styleSimilarity?: number;
  risk: "pass" | "fail" | "unknown";
  failureReasons: string[];
  notes?: string;
}

export interface QualityReviewInput {
  jobId: string;
  referenceImagePathOrUrls: string[];
  subjectImagePathOrUrls: string[];
  outputImagePathOrUrls: string[];
  recipe: StyleRecipe;
}

export interface QualityReviewOutput {
  jobId: string;
  status: "reviewed" | "needs_manual_review" | "failed";
  scores: Record<string, QualityScore>;
  error?: string;
}

export interface GeneratePortraitInput {
  jobId: string;
  mode: ImageProviderMode;
  referenceImagePathOrUrls: string[];
  subjectImagePathOrUrls: string[];
  recipe: StyleRecipe;
  count: number;
  maxRetries: number;
  outputDirectory?: string;
}

export interface GeneratePortraitOutput {
  jobId: string;
  status:
    | "queued"
    | "running"
    | "needs-manual-codex"
    | "succeeded"
    | "partial_succeeded"
    | "failed"
    | "retrying"
    | "dead_letter";
  images: Array<{
    id: string;
    pathOrUrl: string;
    width?: number;
    height?: number;
    score?: QualityScore;
  }>;
  error?: string;
}

export interface ImageProvider {
  analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe>;
  generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput>;
  reviewQuality(input: QualityReviewInput): Promise<QualityReviewOutput>;
}
