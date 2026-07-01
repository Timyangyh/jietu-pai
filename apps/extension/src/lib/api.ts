import { browser } from "wxt/browser";
import type { ImageProviderMode, LocalGenerationJobManifest, QualityScore, StyleRecipe } from "@styleme/core";

export const LOCAL_API_BASE = "http://127.0.0.1:8787";

export interface ImagePayload {
  dataUrl?: string;
  sourceUrl?: string;
  fileName?: string;
}

export interface ReferenceSource {
  altText?: string;
  fileName?: string;
  pageTitle?: string;
  pageUrl?: string;
  sourceUrl?: string;
}

export interface HealthResponse {
  ok: boolean;
  projectRoot: string;
  runsRoot: string;
  hasOpenAIKey: boolean;
  activeProvider: ImageProviderMode;
}

export interface ProviderSummary {
  mode: ImageProviderMode;
  label: string;
  active: boolean;
  enabled: boolean;
  configured: boolean;
  status: "available" | "needs_config" | "experimental" | "unavailable";
  detail: string;
  keySource?: "env" | "local-settings" | "none";
  model?: string;
  baseUrl?: string;
}

export type ThirdPartyProviderKey = "geminiNanoBanana" | "openrouter" | "custom";

export interface ThirdPartyProviderSummary {
  key: ThirdPartyProviderKey;
  label: string;
  active: boolean;
  configured: boolean;
  enabled: boolean;
  status: "available" | "needs_config";
  detail: string;
  keySource: "env" | "local-settings" | "none";
  baseUrl: string;
  model: string;
  analysisModel: string;
}

export interface ProviderSettingsResponse {
  ok: true;
  activeProvider: ImageProviderMode;
  providers: ProviderSummary[];
  thirdPartyProviders: ThirdPartyProviderSummary[];
}

export async function getHealth(): Promise<HealthResponse> {
  return request("/health");
}

export async function analyzeRecipe(reference: ImagePayload, source: ReferenceSource, providerMode?: ImageProviderMode): Promise<{
  recipe: StyleRecipe;
}> {
  return request("/v1/recipes/analyze", {
    method: "POST",
    body: JSON.stringify({ reference, source, providerMode })
  });
}

export async function createCodexJob(input: {
  reference: ImagePayload;
  subjects: ImagePayload[];
  source: ReferenceSource;
  recipe?: StyleRecipe;
  count: number;
}): Promise<{ job: LocalGenerationJobManifest; nextAction: string }> {
  return request("/v1/jobs/codex", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createGeneration(input: {
  reference: ImagePayload;
  subjects: ImagePayload[];
  source: ReferenceSource;
  recipe?: StyleRecipe;
  count: number;
  providerMode?: ImageProviderMode;
}): Promise<{ job: LocalGenerationJobManifest }> {
  return request("/v1/generations", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getProviderSettings(): Promise<ProviderSettingsResponse> {
  return request("/v1/settings/providers");
}

export async function saveProviderSettings(input: {
  activeProvider?: ImageProviderMode;
  openai?: {
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
  };
  thirdParty?: Partial<{
    activeConfig: ThirdPartyProviderKey;
    geminiNanoBanana: ProviderConfigUpdate;
    openrouter: ProviderConfigUpdate;
    custom: ProviderConfigUpdate;
  }>;
}): Promise<ProviderSettingsResponse> {
  return request("/v1/settings/providers", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export interface ProviderConfigUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  model?: string;
  analysisModel?: string;
}

export async function listJobs(): Promise<{ jobs: LocalGenerationJobManifest[] }> {
  return request("/v1/gallery");
}

export async function refreshJob(jobId: string): Promise<{ job: LocalGenerationJobManifest }> {
  return request(`/v1/generations/${encodeURIComponent(jobId)}`);
}

export async function refreshCodexJob(jobId: string): Promise<{ job: LocalGenerationJobManifest }> {
  return request(`/v1/jobs/${encodeURIComponent(jobId)}/refresh`, {
    method: "POST",
    body: "{}"
  });
}

export async function retryGeneration(jobId: string): Promise<{ job: LocalGenerationJobManifest }> {
  return request(`/v1/generations/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: "{}"
  });
}

export async function saveReview(jobId: string, scores: Record<string, QualityScore>): Promise<void> {
  await request(`/v1/generations/${encodeURIComponent(jobId)}/review`, {
    method: "POST",
    body: JSON.stringify({ scores })
  });
}

export async function saveCodexReview(jobId: string, scores: Record<string, QualityScore>): Promise<void> {
  await request(`/v1/jobs/${encodeURIComponent(jobId)}/review`, {
    method: "POST",
    body: JSON.stringify({ scores })
  });
}

export async function setFavorite(jobId: string, imageId: string, favorite: boolean): Promise<void> {
  await request(`/v1/generations/${encodeURIComponent(jobId)}/favorite`, {
    method: "POST",
    body: JSON.stringify({ imageId, favorite })
  });
}

export async function deleteOutput(jobId: string, imageId: string, providerMode?: ImageProviderMode): Promise<void> {
  const prefix = providerMode === "codex-dev" ? "/v1/jobs" : "/v1/generations";
  await request(`${prefix}/${encodeURIComponent(jobId)}/delete`, {
    method: "POST",
    body: JSON.stringify({ imageId, deleted: true })
  });
}

export async function deleteJob(jobId: string, providerMode?: ImageProviderMode): Promise<void> {
  const prefix = providerMode === "codex-dev" ? "/v1/jobs" : "/v1/generations";
  await request(`${prefix}/${encodeURIComponent(jobId)}/delete-job`, {
    method: "POST",
    body: "{}"
  });
}

export function absoluteLocalUrl(urlOrPath: string): string {
  if (urlOrPath.startsWith("http")) return urlOrPath;
  return `${LOCAL_API_BASE}${urlOrPath}`;
}

interface LocalApiProxyResponse {
  ok: boolean;
  status: number;
  text: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = (await browser.runtime.sendMessage({
    type: "STYLEME_LOCAL_API",
    path,
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? init.body : undefined
  })) as LocalApiProxyResponse;
  const body = response.text ? JSON.parse(response.text) : {};
  if (!response.ok) {
    throw new Error(body.error ?? `Local API failed: ${response.status}`);
  }
  return body as T;
}
