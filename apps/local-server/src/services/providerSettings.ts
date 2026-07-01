import path from "node:path";
import type { ImageProviderMode } from "@styleme/core";
import { removeProjectEnvKeys } from "../lib/env";
import { readJsonFile, writeJsonFile } from "../lib/json";
import { localLibraryRoot } from "../lib/paths";

const DEFAULT_OPENAI_MODEL = "gpt-image-2";
const DEFAULT_OPENAI_ANALYSIS_MODEL = "gpt-4.1-mini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash-image-preview";
const DEFAULT_CUSTOM_MODEL = "custom-image-model";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const settingsPath = path.join(localLibraryRoot, "provider-settings.json");

export type ProviderKeySource = "env" | "local-settings" | "none";
export type ThirdPartyProviderKey = "geminiNanoBanana" | "openrouter" | "custom";

export interface ProviderApiConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  analysisModel?: string;
}

export interface ThirdPartyProviderSettings {
  activeConfig: ThirdPartyProviderKey;
  activeAnalysisConfig: ThirdPartyProviderKey;
  geminiNanoBanana: ProviderApiConfig;
  openrouter: ProviderApiConfig;
  custom: ProviderApiConfig;
}

export interface RawProviderSettings {
  schemaVersion: 1;
  updatedAt: string;
  activeProvider: ImageProviderMode;
  activeAnalysisProvider: ImageProviderMode;
  openai: {
    apiKey?: string;
    model: string;
    analysisModel: string;
  };
  thirdParty: ThirdPartyProviderSettings;
}

export interface ProviderApiConfigUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  model?: string;
  analysisModel?: string;
}

export interface ProviderSettingsUpdate {
  activeProvider?: ImageProviderMode;
  activeAnalysisProvider?: ImageProviderMode;
  openai?: {
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
    analysisModel?: string;
  };
  thirdParty?: Partial<{
    activeConfig: ThirdPartyProviderKey;
    activeAnalysisConfig: ThirdPartyProviderKey;
    geminiNanoBanana: ProviderApiConfigUpdate;
    openrouter: ProviderApiConfigUpdate;
    custom: ProviderApiConfigUpdate;
  }>;
}

export interface ProviderSummary {
  mode: ImageProviderMode;
  label: string;
  active: boolean;
  analysisActive: boolean;
  enabled: boolean;
  analysisEnabled: boolean;
  configured: boolean;
  analysisConfigured: boolean;
  status: "available" | "needs_config" | "experimental" | "unavailable";
  detail: string;
  keySource?: ProviderKeySource;
  model?: string;
  analysisModel?: string;
  baseUrl?: string;
  spike?: {
    browserOrDeviceFlow: "unknown" | "available" | "unavailable";
    submitImagesAndPrompt: "unknown" | "available" | "unavailable";
    fetchGeneratedImage: "unknown" | "available" | "unavailable";
  };
}

export interface ThirdPartyProviderSummary {
  key: ThirdPartyProviderKey;
  label: string;
  active: boolean;
  analysisActive: boolean;
  activeForGeneration: boolean;
  activeForAnalysis: boolean;
  configured: boolean;
  analysisConfigured: boolean;
  enabled: boolean;
  generationEnabled: boolean;
  analysisEnabled: boolean;
  status: "available" | "needs_config";
  detail: string;
  keySource: ProviderKeySource;
  baseUrl: string;
  model: string;
  analysisModel: string;
}

export interface ProviderSettingsResponse {
  ok: true;
  activeProvider: ImageProviderMode;
  activeAnalysisProvider: ImageProviderMode;
  providers: ProviderSummary[];
  thirdPartyProviders: ThirdPartyProviderSummary[];
}

export async function readProviderSettings(): Promise<RawProviderSettings> {
  const raw = await readJsonFile<Partial<RawProviderSettings>>(settingsPath, defaultProviderSettings());
  return normalizeProviderSettings(raw);
}

export async function updateProviderSettings(update: ProviderSettingsUpdate): Promise<ProviderSettingsResponse> {
  const current = await readProviderSettings();
  const next: RawProviderSettings = {
    ...current,
    updatedAt: new Date().toISOString(),
    ...(update.activeProvider ? { activeProvider: normalizeProviderMode(update.activeProvider) } : {}),
    ...(update.activeAnalysisProvider ? { activeAnalysisProvider: normalizeProviderMode(update.activeAnalysisProvider) } : {}),
    openai: {
      ...current.openai,
      ...(typeof update.openai?.model === "string" ? { model: update.openai.model.trim() || DEFAULT_OPENAI_MODEL } : {}),
      ...(typeof update.openai?.analysisModel === "string"
        ? { analysisModel: update.openai.analysisModel.trim() || DEFAULT_OPENAI_ANALYSIS_MODEL }
        : {})
    },
    thirdParty: updateThirdPartySettings(current.thirdParty, update.thirdParty)
  };

  if (update.openai?.clearApiKey) {
    delete next.openai.apiKey;
    await removeProjectEnvKeys(["OPENAI_API_KEY"]);
  } else if (typeof update.openai?.apiKey === "string" && update.openai.apiKey.trim()) {
    next.openai.apiKey = update.openai.apiKey.trim();
  }

  await clearThirdPartyEnvKeys(update.thirdParty);

  await writeJsonFile(settingsPath, next);
  return summarizeProviderSettings(next);
}

export async function summarizeCurrentProviderSettings(): Promise<ProviderSettingsResponse> {
  return summarizeProviderSettings(await readProviderSettings());
}

export function getOpenAIApiKey(settings: RawProviderSettings): { apiKey?: string; source: ProviderKeySource } {
  if (process.env.OPENAI_API_KEY) {
    return { apiKey: process.env.OPENAI_API_KEY, source: "env" };
  }
  if (settings.openai.apiKey) {
    return { apiKey: settings.openai.apiKey, source: "local-settings" };
  }
  return { source: "none" };
}

export function getOpenAIModel(settings: RawProviderSettings): string {
  return process.env.OPENAI_IMAGE_MODEL || settings.openai.model || DEFAULT_OPENAI_MODEL;
}

export function getOpenAIAnalysisModel(settings: RawProviderSettings): string {
  return process.env.OPENAI_ANALYSIS_MODEL || settings.openai.analysisModel || DEFAULT_OPENAI_ANALYSIS_MODEL;
}

export function getThirdPartyApiConfig(
  settings: RawProviderSettings,
  key: ThirdPartyProviderKey
): ProviderApiConfig & {
  analysisModel: string;
  keySource: ProviderKeySource;
  configured: boolean;
  generationConfigured: boolean;
  analysisConfigured: boolean;
} {
  const config = settings.thirdParty[key];
  const env = thirdPartyEnv(key);
  const envApiKey = firstEnv(env.apiKey);
  const apiKey = envApiKey ?? config.apiKey;
  const baseUrl = firstEnv(env.baseUrl) ?? config.baseUrl;
  const model = firstEnv(env.model) ?? config.model;
  const analysisModel = firstEnv(env.analysisModel) ?? config.analysisModel ?? "";
  return {
    baseUrl,
    model,
    analysisModel,
    ...(apiKey ? { apiKey } : {}),
    keySource: envApiKey ? "env" : config.apiKey ? "local-settings" : "none",
    configured: Boolean(apiKey && baseUrl && model),
    generationConfigured: Boolean(apiKey && baseUrl && model),
    analysisConfigured: Boolean(apiKey && baseUrl && analysisModel)
  };
}

export function getEffectiveThirdPartyProviderKey(
  settings: RawProviderSettings,
  usage: "generation" | "analysis" = "generation"
): ThirdPartyProviderKey {
  return usage === "analysis" ? settings.thirdParty.activeAnalysisConfig : settings.thirdParty.activeConfig;
}

function summarizeProviderSettings(settings: RawProviderSettings): ProviderSettingsResponse {
  const openaiKey = getOpenAIApiKey(settings);
  const hasOpenAIKey = Boolean(openaiKey.apiKey);
  const openaiModel = getOpenAIModel(settings);
  const openaiAnalysisModel = getOpenAIAnalysisModel(settings);
  const thirdPartyProviders = summarizeThirdPartyProviders(settings);
  const hasThirdPartyConfig = thirdPartyProviders.some((provider) => provider.generationEnabled);
  const hasThirdPartyAnalysisConfig = thirdPartyProviders.some((provider) => provider.analysisEnabled);
  const activeThirdParty = thirdPartyProviders.find((provider) => provider.activeForGeneration);
  const activeAnalysisThirdParty = thirdPartyProviders.find((provider) => provider.activeForAnalysis);
  const hasEnabledThirdParty = Boolean(activeThirdParty?.generationEnabled);
  const hasEnabledThirdPartyAnalysis = Boolean(activeAnalysisThirdParty?.analysisEnabled);
  return {
    ok: true,
    activeProvider: settings.activeProvider,
    activeAnalysisProvider: settings.activeAnalysisProvider,
    providers: [
      {
        mode: "mock",
        label: "Mock 占位测试",
        active: settings.activeProvider === "mock",
        analysisActive: settings.activeAnalysisProvider === "mock",
        enabled: true,
        analysisEnabled: true,
        configured: true,
        analysisConfigured: true,
        status: "available",
        detail: "0 成本占位生成，只验证插件流程和相册，不是真实 AI 写真。"
      },
      {
        mode: "openai-api",
        label: "OpenAI",
        active: settings.activeProvider === "openai-api",
        analysisActive: settings.activeAnalysisProvider === "openai-api",
        enabled: hasOpenAIKey,
        analysisEnabled: hasOpenAIKey,
        configured: hasOpenAIKey,
        analysisConfigured: hasOpenAIKey,
        status: hasOpenAIKey ? "available" : "needs_config",
        detail: hasOpenAIKey
          ? "使用本地 OPENAI_API_KEY，可分别用于识图和生图；效果以实际输出为准。"
          : "本地服务未配置 OPENAI_API_KEY。",
        keySource: openaiKey.source,
        model: openaiModel,
        analysisModel: openaiAnalysisModel
      },
      {
        mode: "codex-account",
        label: "Codex OAuth",
        active: settings.activeProvider === "codex-account",
        analysisActive: settings.activeAnalysisProvider === "codex-account",
        enabled: true,
        analysisEnabled: true,
        configured: true,
        analysisConfigured: true,
        status: "experimental",
        detail: "调用本机已登录的 codex CLI，使用 ChatGPT/Codex OAuth 会话；不读取 OAuth token 文件。",
        spike: {
          browserOrDeviceFlow: "available",
          submitImagesAndPrompt: "available",
          fetchGeneratedImage: "unknown"
        }
      },
      {
        mode: "third-party",
        label: "第三方 API",
        active: settings.activeProvider === "third-party",
        analysisActive: settings.activeAnalysisProvider === "third-party",
        enabled: hasEnabledThirdParty,
        analysisEnabled: hasEnabledThirdPartyAnalysis,
        configured: Boolean(activeThirdParty?.generationEnabled ?? hasThirdPartyConfig),
        analysisConfigured: Boolean(activeAnalysisThirdParty?.analysisEnabled ?? hasThirdPartyAnalysisConfig),
        status: hasEnabledThirdParty || hasEnabledThirdPartyAnalysis ? "available" : "needs_config",
        detail: hasEnabledThirdParty
          ? `生图使用 ${activeThirdParty?.label}；识图可单独选择 ${activeAnalysisThirdParty?.label ?? "第三方 API"}。`
          : hasEnabledThirdPartyAnalysis
            ? `识图使用 ${activeAnalysisThirdParty?.label}；还未配置可用于生图的第三方 API。`
            : "可先保存 Gemini Nano Banana、OpenRouter 或兼容 /images 的自定义 API 配置；已配置后可分别切换识图和生图。",
        ...(activeThirdParty?.keySource ? { keySource: activeThirdParty.keySource } : {}),
        ...(activeThirdParty?.model ? { model: activeThirdParty.model } : {}),
        ...(activeAnalysisThirdParty?.analysisModel ? { analysisModel: activeAnalysisThirdParty.analysisModel } : {}),
        ...(activeThirdParty?.baseUrl ? { baseUrl: activeThirdParty.baseUrl } : {})
      },
      {
        mode: "codex-dev",
        label: "Codex 调试",
        active: settings.activeProvider === "codex-dev",
        analysisActive: settings.activeAnalysisProvider === "codex-dev",
        enabled: true,
        analysisEnabled: false,
        configured: true,
        analysisConfigured: false,
        status: "experimental",
        detail: "高级调试入口，只创建 runs/codex-jobs 任务包，不自动生成。"
      }
    ],
    thirdPartyProviders
  };
}

function defaultProviderSettings(): RawProviderSettings {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    activeProvider: "mock",
    activeAnalysisProvider: "mock",
    openai: {
      model: DEFAULT_OPENAI_MODEL,
      analysisModel: DEFAULT_OPENAI_ANALYSIS_MODEL
    },
    thirdParty: defaultThirdPartySettings()
  };
}

function normalizeProviderMode(mode: ImageProviderMode): ImageProviderMode {
  const allowed: ImageProviderMode[] = ["mock", "openai-api", "codex-account", "third-party", "codex-dev"];
  if (allowed.includes(mode)) return mode;
  return "mock";
}

function defaultThirdPartySettings(): ThirdPartyProviderSettings {
  return {
    activeConfig: "geminiNanoBanana",
    activeAnalysisConfig: "geminiNanoBanana",
    geminiNanoBanana: {
      baseUrl: DEFAULT_GEMINI_BASE_URL,
      model: DEFAULT_GEMINI_MODEL
    },
    openrouter: {
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      model: DEFAULT_OPENROUTER_MODEL
    },
    custom: {
      baseUrl: "",
      model: DEFAULT_CUSTOM_MODEL
    }
  };
}

function normalizeProviderSettings(value: Partial<RawProviderSettings>): RawProviderSettings {
  const defaults = defaultProviderSettings();
  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt ?? defaults.updatedAt,
    activeProvider: value.activeProvider ? normalizeProviderMode(value.activeProvider) : defaults.activeProvider,
    activeAnalysisProvider: value.activeAnalysisProvider
      ? normalizeProviderMode(value.activeAnalysisProvider)
      : value.activeProvider
        ? normalizeProviderMode(value.activeProvider)
        : defaults.activeAnalysisProvider,
    openai: {
      ...defaults.openai,
      ...(value.openai ?? {})
    },
    thirdParty: normalizeThirdPartySettings(value.thirdParty)
  };
}

function normalizeThirdPartySettings(value?: Partial<ThirdPartyProviderSettings>): ThirdPartyProviderSettings {
  const defaults = defaultThirdPartySettings();
  return {
    activeConfig: isThirdPartyProviderKey(value?.activeConfig) ? value.activeConfig : defaults.activeConfig,
    activeAnalysisConfig: isThirdPartyProviderKey(value?.activeAnalysisConfig)
      ? value.activeAnalysisConfig
      : isThirdPartyProviderKey(value?.activeConfig)
        ? value.activeConfig
        : defaults.activeAnalysisConfig,
    geminiNanoBanana: normalizeProviderApiConfig(value?.geminiNanoBanana, defaults.geminiNanoBanana),
    openrouter: normalizeProviderApiConfig(value?.openrouter, defaults.openrouter),
    custom: normalizeProviderApiConfig(value?.custom, defaults.custom)
  };
}

function normalizeProviderApiConfig(
  value: Partial<ProviderApiConfig> | undefined,
  defaults: ProviderApiConfig
): ProviderApiConfig {
  const model = value?.model?.trim() || defaults.model;
  const next: ProviderApiConfig = {
    ...defaults,
    ...(value ?? {}),
    baseUrl: value?.baseUrl?.trim() ?? defaults.baseUrl,
    model
  };
  const rawAnalysisModel =
    typeof value?.analysisModel === "string" ? value.analysisModel.trim() : defaults.analysisModel?.trim();
  if (rawAnalysisModel && !isLikelyImageGenerationModel(rawAnalysisModel)) {
    next.analysisModel = rawAnalysisModel;
  } else {
    delete next.analysisModel;
  }
  return next;
}

function isLikelyImageGenerationModel(model: string): boolean {
  return /(?:^|[/_-])(?:gpt-)?image(?:[/_-]|$)|flux|imagen|dall-e/i.test(model);
}

function updateThirdPartySettings(
  current: ThirdPartyProviderSettings,
  update?: ProviderSettingsUpdate["thirdParty"]
): ThirdPartyProviderSettings {
  if (!update) return current;
  return {
    ...current,
    ...(isThirdPartyProviderKey(update.activeConfig) ? { activeConfig: update.activeConfig } : {}),
    ...(isThirdPartyProviderKey(update.activeAnalysisConfig) ? { activeAnalysisConfig: update.activeAnalysisConfig } : {}),
    geminiNanoBanana: updateProviderApiConfig(current.geminiNanoBanana, update.geminiNanoBanana),
    openrouter: updateProviderApiConfig(current.openrouter, update.openrouter),
    custom: updateProviderApiConfig(current.custom, update.custom)
  };
}

function updateProviderApiConfig(current: ProviderApiConfig, update?: ProviderApiConfigUpdate): ProviderApiConfig {
  const next: ProviderApiConfig = {
    ...current,
    ...(typeof update?.baseUrl === "string" ? { baseUrl: update.baseUrl.trim() } : {}),
    ...(typeof update?.model === "string" ? { model: update.model.trim() || current.model } : {})
  };
  if (typeof update?.analysisModel === "string") {
    const analysisModel = update.analysisModel.trim();
    if (analysisModel) {
      next.analysisModel = analysisModel;
    } else {
      delete next.analysisModel;
    }
  }
  if (update?.clearApiKey) {
    delete next.apiKey;
  } else if (typeof update?.apiKey === "string" && update.apiKey.trim()) {
    next.apiKey = update.apiKey.trim();
  }
  return next;
}

async function clearThirdPartyEnvKeys(update?: ProviderSettingsUpdate["thirdParty"]): Promise<void> {
  if (!update) return;
  const keysToRemove = thirdPartyProviderKeys().flatMap((key) =>
    update[key]?.clearApiKey ? thirdPartyEnv(key).apiKey : []
  );
  if (keysToRemove.length > 0) {
    await removeProjectEnvKeys(keysToRemove);
  }
}

function summarizeThirdPartyProviders(settings: RawProviderSettings): ThirdPartyProviderSummary[] {
  const effectiveActiveConfig = getEffectiveThirdPartyProviderKey(settings, "generation");
  const effectiveActiveAnalysisConfig = getEffectiveThirdPartyProviderKey(settings, "analysis");
  return thirdPartyProviderKeys().map((key) => {
    const config = getThirdPartyApiConfig(settings, key);
    const generationEnabled = config.generationConfigured;
    const analysisEnabled = config.analysisConfigured;
    return {
      key,
      label: thirdPartyLabel(key),
      active: effectiveActiveConfig === key,
      analysisActive: effectiveActiveAnalysisConfig === key,
      activeForGeneration: effectiveActiveConfig === key,
      activeForAnalysis: effectiveActiveAnalysisConfig === key,
      configured: generationEnabled,
      analysisConfigured: analysisEnabled,
      enabled: generationEnabled,
      generationEnabled,
      analysisEnabled,
      status: generationEnabled || analysisEnabled ? "available" : "needs_config",
      detail: !generationEnabled && !analysisEnabled
        ? "未配置 API key。"
        : generationEnabled && analysisEnabled
          ? thirdPartyAvailableDetail(key)
          : generationEnabled
            ? "已配置生图；看图分析模型未配置。"
            : "已配置识图；生图模型未配置。",
      keySource: config.keySource,
      baseUrl: config.baseUrl,
      model: config.model,
      analysisModel: config.analysisModel
    };
  });
}

function thirdPartyProviderKeys(): ThirdPartyProviderKey[] {
  return ["geminiNanoBanana", "openrouter", "custom"];
}

function isThirdPartyProviderKey(value: unknown): value is ThirdPartyProviderKey {
  return typeof value === "string" && thirdPartyProviderKeys().includes(value as ThirdPartyProviderKey);
}

function thirdPartyLabel(key: ThirdPartyProviderKey): string {
  if (key === "geminiNanoBanana") return "Gemini Nano Banana";
  if (key === "openrouter") return "OpenRouter";
  return "自定义 API";
}

function thirdPartyAvailableDetail(key: ThirdPartyProviderKey): string {
  if (key === "geminiNanoBanana") return "配置已保存，可通过 Gemini Interactions API 生成。";
  if (key === "openrouter") return "配置已保存，可通过 OpenRouter Images API 生成。";
  return "配置已保存，可通过兼容 /images 的自定义 API 生成。";
}

function thirdPartyEnv(key: ThirdPartyProviderKey): {
  apiKey: string[];
  baseUrl: string[];
  model: string[];
  analysisModel: string[];
} {
  if (key === "geminiNanoBanana") {
    return {
      apiKey: ["GEMINI_NANO_BANANA_API_KEY", "GEMINI_API_KEY"],
      baseUrl: ["GEMINI_NANO_BANANA_BASE_URL", "GEMINI_BASE_URL"],
      model: ["GEMINI_NANO_BANANA_MODEL", "GEMINI_IMAGE_MODEL"],
      analysisModel: ["GEMINI_NANO_BANANA_ANALYSIS_MODEL", "GEMINI_ANALYSIS_MODEL"]
    };
  }
  if (key === "openrouter") {
    return {
      apiKey: ["OPENROUTER_API_KEY"],
      baseUrl: ["OPENROUTER_BASE_URL"],
      model: ["OPENROUTER_IMAGE_MODEL"],
      analysisModel: ["OPENROUTER_ANALYSIS_MODEL"]
    };
  }
  return {
    apiKey: ["CUSTOM_PROVIDER_API_KEY", "THIRD_PARTY_API_KEY"],
    baseUrl: ["CUSTOM_PROVIDER_BASE_URL", "THIRD_PARTY_BASE_URL"],
    model: ["CUSTOM_PROVIDER_MODEL", "THIRD_PARTY_MODEL"],
    analysisModel: ["CUSTOM_PROVIDER_ANALYSIS_MODEL", "THIRD_PARTY_ANALYSIS_MODEL"]
  };
}

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
