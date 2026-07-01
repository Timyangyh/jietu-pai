import path from "node:path";
import type { ImageProviderMode } from "@styleme/core";
import { removeProjectEnvKeys } from "../lib/env";
import { readJsonFile, writeJsonFile } from "../lib/json";
import { localLibraryRoot } from "../lib/paths";

const DEFAULT_OPENAI_MODEL = "gpt-image-2";
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
}

export interface ThirdPartyProviderSettings {
  activeConfig: ThirdPartyProviderKey;
  geminiNanoBanana: ProviderApiConfig;
  openrouter: ProviderApiConfig;
  custom: ProviderApiConfig;
}

export interface RawProviderSettings {
  schemaVersion: 1;
  updatedAt: string;
  activeProvider: ImageProviderMode;
  openai: {
    apiKey?: string;
    model: string;
  };
  thirdParty: ThirdPartyProviderSettings;
}

export interface ProviderApiConfigUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  model?: string;
}

export interface ProviderSettingsUpdate {
  activeProvider?: ImageProviderMode;
  openai?: {
    apiKey?: string;
    clearApiKey?: boolean;
    model?: string;
  };
  thirdParty?: Partial<{
    activeConfig: ThirdPartyProviderKey;
    geminiNanoBanana: ProviderApiConfigUpdate;
    openrouter: ProviderApiConfigUpdate;
    custom: ProviderApiConfigUpdate;
  }>;
}

export interface ProviderSummary {
  mode: ImageProviderMode;
  label: string;
  active: boolean;
  enabled: boolean;
  configured: boolean;
  status: "available" | "needs_config" | "experimental" | "unavailable";
  detail: string;
  keySource?: ProviderKeySource;
  model?: string;
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
  configured: boolean;
  enabled: boolean;
  status: "needs_adapter" | "needs_config";
  detail: string;
  keySource: ProviderKeySource;
  baseUrl: string;
  model: string;
}

export interface ProviderSettingsResponse {
  ok: true;
  activeProvider: ImageProviderMode;
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
    openai: {
      ...current.openai,
      ...(typeof update.openai?.model === "string" ? { model: update.openai.model.trim() || DEFAULT_OPENAI_MODEL } : {})
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

export function getThirdPartyApiConfig(
  settings: RawProviderSettings,
  key: ThirdPartyProviderKey
): ProviderApiConfig & { keySource: ProviderKeySource; configured: boolean } {
  const config = settings.thirdParty[key];
  const env = thirdPartyEnv(key);
  const envApiKey = firstEnv(env.apiKey);
  const apiKey = envApiKey ?? config.apiKey;
  const baseUrl = firstEnv(env.baseUrl) ?? config.baseUrl;
  const model = firstEnv(env.model) ?? config.model;
  return {
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    keySource: envApiKey ? "env" : config.apiKey ? "local-settings" : "none",
    configured: Boolean(apiKey && baseUrl && model)
  };
}

function summarizeProviderSettings(settings: RawProviderSettings): ProviderSettingsResponse {
  const openaiKey = getOpenAIApiKey(settings);
  const hasOpenAIKey = Boolean(openaiKey.apiKey);
  const openaiModel = getOpenAIModel(settings);
  const thirdPartyProviders = summarizeThirdPartyProviders(settings);
  const hasThirdPartyConfig = thirdPartyProviders.some((provider) => provider.configured);
  return {
    ok: true,
    activeProvider: settings.activeProvider,
    providers: [
      {
        mode: "mock",
        label: "Mock 占位测试",
        active: settings.activeProvider === "mock",
        enabled: true,
        configured: true,
        status: "available",
        detail: "0 成本占位生成，只验证插件流程和相册，不是真实 AI 写真。"
      },
      {
        mode: "openai-api",
        label: "OpenAI",
        active: settings.activeProvider === "openai-api",
        enabled: hasOpenAIKey,
        configured: hasOpenAIKey,
        status: hasOpenAIKey ? "available" : "needs_config",
        detail: hasOpenAIKey
          ? "使用本地 OPENAI_API_KEY 生成图片；效果以实际输出为准。"
          : "本地服务未配置 OPENAI_API_KEY。",
        keySource: openaiKey.source,
        model: openaiModel
      },
      {
        mode: "codex-account",
        label: "Codex OAuth",
        active: settings.activeProvider === "codex-account",
        enabled: true,
        configured: true,
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
        enabled: false,
        configured: hasThirdPartyConfig,
        status: "unavailable",
        detail: hasThirdPartyConfig
          ? "已保存第三方 API 配置；Adapter 尚未接入，暂不能用于生成。"
          : "可先保存 Gemini Nano Banana、OpenRouter 或自定义 API 配置；Adapter 尚未接入。"
      },
      {
        mode: "codex-dev",
        label: "Codex 调试",
        active: settings.activeProvider === "codex-dev",
        enabled: true,
        configured: true,
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
    openai: {
      model: DEFAULT_OPENAI_MODEL
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
    geminiNanoBanana: normalizeProviderApiConfig(value?.geminiNanoBanana, defaults.geminiNanoBanana),
    openrouter: normalizeProviderApiConfig(value?.openrouter, defaults.openrouter),
    custom: normalizeProviderApiConfig(value?.custom, defaults.custom)
  };
}

function normalizeProviderApiConfig(
  value: Partial<ProviderApiConfig> | undefined,
  defaults: ProviderApiConfig
): ProviderApiConfig {
  return {
    ...defaults,
    ...(value ?? {}),
    baseUrl: value?.baseUrl?.trim() ?? defaults.baseUrl,
    model: value?.model?.trim() || defaults.model
  };
}

function updateThirdPartySettings(
  current: ThirdPartyProviderSettings,
  update?: ProviderSettingsUpdate["thirdParty"]
): ThirdPartyProviderSettings {
  if (!update) return current;
  return {
    ...current,
    ...(isThirdPartyProviderKey(update.activeConfig) ? { activeConfig: update.activeConfig } : {}),
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
  return thirdPartyProviderKeys().map((key) => {
    const config = getThirdPartyApiConfig(settings, key);
    return {
      key,
      label: thirdPartyLabel(key),
      active: settings.thirdParty.activeConfig === key,
      configured: config.configured,
      enabled: false,
      status: config.configured ? "needs_adapter" : "needs_config",
      detail: config.configured ? "配置已保存；生成 Adapter 尚未接入。" : "未配置 API key。",
      keySource: config.keySource,
      baseUrl: config.baseUrl,
      model: config.model
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

function thirdPartyEnv(key: ThirdPartyProviderKey): {
  apiKey: string[];
  baseUrl: string[];
  model: string[];
} {
  if (key === "geminiNanoBanana") {
    return {
      apiKey: ["GEMINI_NANO_BANANA_API_KEY", "GEMINI_API_KEY"],
      baseUrl: ["GEMINI_NANO_BANANA_BASE_URL", "GEMINI_BASE_URL"],
      model: ["GEMINI_NANO_BANANA_MODEL", "GEMINI_IMAGE_MODEL"]
    };
  }
  if (key === "openrouter") {
    return {
      apiKey: ["OPENROUTER_API_KEY"],
      baseUrl: ["OPENROUTER_BASE_URL"],
      model: ["OPENROUTER_IMAGE_MODEL"]
    };
  }
  return {
    apiKey: ["CUSTOM_PROVIDER_API_KEY", "THIRD_PARTY_API_KEY"],
    baseUrl: ["CUSTOM_PROVIDER_BASE_URL", "THIRD_PARTY_BASE_URL"],
    model: ["CUSTOM_PROVIDER_MODEL", "THIRD_PARTY_MODEL"]
  };
}

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
