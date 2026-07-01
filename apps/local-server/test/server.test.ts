import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { createStyleMeServer } from "../src/server";
import { projectEnvPath } from "../src/lib/env";
import { localLibraryRoot, projectRoot } from "../src/lib/paths";

let server: http.Server;
let baseUrl: string;
const restoreFiles = [
  ...["provider-settings.json", "gallery.json"].map((fileName) => path.join(localLibraryRoot, fileName)),
  projectEnvPath
];
const fileSnapshots = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const filePath of restoreFiles) {
    try {
      fileSnapshots.set(filePath, await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fileSnapshots.set(filePath, undefined);
    }
  }
  server = createStyleMeServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
  for (const [filePath, snapshot] of fileSnapshots.entries()) {
    if (snapshot === undefined) {
      await fs.rm(filePath, { force: true });
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, snapshot, "utf8");
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local server", () => {
  it("returns local service health status", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; activeProvider: string };
    expect(body.ok).toBe(true);
    expect(body.activeProvider).toBeTruthy();
  });

  it("does not expose local API CORS access to regular websites", async () => {
    const blockedResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.invalid",
        "access-control-request-method": "POST"
      }
    });
    expect(blockedResponse.status).toBe(204);
    expect(blockedResponse.headers.get("access-control-allow-origin")).toBeNull();

    const localPageResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "POST"
      }
    });
    expect(localPageResponse.status).toBe(204);
    expect(localPageResponse.headers.get("access-control-allow-origin")).toBeNull();

    const extensionResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "OPTIONS",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "access-control-request-method": "POST"
      }
    });
    expect(extensionResponse.status).toBe(204);
    expect(extensionResponse.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
  });

  it("switches freely between Codex OAuth and a configured third-party API", async () => {
    const setupResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "openrouter",
          activeAnalysisConfig: "openrouter",
          openrouter: {
            apiKey: "sk-or-test",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/gpt-image-2",
            analysisModel: "qwen/qwen2.5-vl-72b-instruct"
          }
        }
      })
    });
    expect(setupResponse.ok).toBe(true);

    const codexResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeProvider: "codex-account" })
    });
    expect(codexResponse.ok).toBe(true);
    const codexSettings = (await codexResponse.json()) as {
      activeProvider: string;
      providers: Array<{ mode: string; active: boolean; enabled: boolean }>;
    };
    expect(codexSettings.activeProvider).toBe("codex-account");
    expect(codexSettings.providers.find((provider) => provider.mode === "codex-account")).toMatchObject({
      active: true,
      enabled: true
    });

    const thirdPartyResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        thirdParty: { activeConfig: "openrouter" }
      })
    });
    expect(thirdPartyResponse.ok).toBe(true);
    const thirdPartySettings = (await thirdPartyResponse.json()) as {
      activeProvider: string;
      providers: Array<{ mode: string; active: boolean; enabled: boolean }>;
      thirdPartyProviders: Array<{ key: string; active: boolean; enabled: boolean; analysisModel: string }>;
    };
    expect(thirdPartySettings.activeProvider).toBe("third-party");
    expect(thirdPartySettings.providers.find((provider) => provider.mode === "third-party")).toMatchObject({
      active: true,
      enabled: true
    });
    expect(thirdPartySettings.thirdPartyProviders.find((provider) => provider.key === "openrouter")).toMatchObject({
      active: true,
      enabled: true,
      analysisModel: "qwen/qwen2.5-vl-72b-instruct"
    });
  });

  it("allows unconfigured API providers to be selected for setup", async () => {
    const response = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "openai-api",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "custom",
          activeAnalysisConfig: "custom",
          custom: {
            clearApiKey: true,
            baseUrl: "",
            model: ""
          }
        }
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      activeProvider: string;
      activeAnalysisProvider: string;
      providers: Array<{
        mode: string;
        active: boolean;
        analysisActive: boolean;
        enabled: boolean;
        analysisEnabled: boolean;
        status: string;
      }>;
      thirdPartyProviders: Array<{
        key: string;
        activeForGeneration: boolean;
        activeForAnalysis: boolean;
        generationEnabled: boolean;
        analysisEnabled: boolean;
      }>;
    };
    expect(body.activeProvider).toBe("openai-api");
    expect(body.activeAnalysisProvider).toBe("third-party");
    expect(body.providers.find((provider) => provider.mode === "openai-api")).toMatchObject({
      active: true,
      enabled: false,
      status: "needs_config"
    });
    expect(body.providers.find((provider) => provider.mode === "third-party")).toMatchObject({
      analysisActive: true,
      analysisEnabled: false,
      status: "needs_config"
    });
    expect(body.thirdPartyProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "custom",
          activeForGeneration: true,
          activeForAnalysis: true,
          generationEnabled: false,
          analysisEnabled: false
        })
      ])
    );
  });

  it("only serves generated image files through the local media endpoint", async () => {
    await fs.writeFile(projectEnvPath, "OPENAI_API_KEY=should-not-leak\n", "utf8");

    const envResponse = await fetch(`${baseUrl}/v1/files?path=${encodeURIComponent(".env")}`);
    expect(envResponse.status).toBe(403);
    expect(await envResponse.text()).not.toContain("should-not-leak");

    const sourceResponse = await fetch(`${baseUrl}/v1/files?path=${encodeURIComponent("package.json")}`);
    expect(sourceResponse.status).toBe(403);

    const imagePath = path.join(localLibraryRoot, "references", "test-reference.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(
      imagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==", "base64")
    );

    const relativePath = path.relative(projectRoot, imagePath);
    const imageResponse = await fetch(`${baseUrl}/v1/files?path=${encodeURIComponent(relativePath)}`);
    expect(imageResponse.ok).toBe(true);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect((await imageResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("analyzes a reference image data URL into a complete recipe", async () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "summer.png" },
        source: { pageTitle: "summer green outdoor" },
        providerMode: "mock"
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { recipe: { title: string; promptZh: string } };
    expect(body.recipe.title).toContain("夏日");
    expect(body.recipe.promptZh).toContain("人物图");
  });

  it("analyzes OpenAI API references from the image instead of page hints", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const analyzedRecipe = outdoorReferenceRecipe("recipe_openai_test");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url === "https://api.openai.com/v1/responses") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify({ output_text: JSON.stringify(analyzedRecipe) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return realFetch(input, init);
    });

    const settingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "openai-api",
        openai: {
          apiKey: "sk-openai-test",
          model: "gpt-image-2"
        }
      })
    });
    expect(settingsResponse.ok).toBe(true);

    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "openai-api"
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { recipe: { scene: string; promptZh: string } };
    expect(body.recipe.scene).toContain("花园");
    expect(body.recipe.scene).not.toContain("古镇");
    expect(body.recipe.promptZh).toContain("户外花园");
    expect(requests.at(-1)?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer sk-openai-test");
    expect(JSON.stringify(requests.at(-1)?.body)).not.toContain("汉服 古镇");
  });

  it("does not report third-party analysis success when the provider fails or returns generic placeholders", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            error: {
              message: "vision model rejected image input"
            }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return realFetch(input, init);
    });

    const settingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "openrouter",
          activeAnalysisConfig: "openrouter",
          openrouter: {
            apiKey: "sk-or-test",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "google/gemini-2.5-flash-image-preview",
            analysisModel: "google/gemini-2.5-flash"
          }
        }
      })
    });
    expect(settingsResponse.ok).toBe(true);

    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "third-party"
      })
    });
    expect(response.ok).toBe(false);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("OpenRouter");
    expect(body.error).toContain("vision model rejected image input");
  });

  it("requires an explicit third-party analysis model before analyzing references", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const requests: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        requests.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ error: { message: "analysis model should not be called" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
      return realFetch(input, init);
    });

    const settingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "openrouter",
          activeAnalysisConfig: "openrouter",
          openrouter: {
            apiKey: "sk-or-test",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/gpt-image-2",
            analysisModel: ""
          }
        }
      })
    });
    expect(settingsResponse.ok).toBe(true);

    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "third-party"
      })
    });
    expect(response.ok).toBe(false);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("OpenRouter");
    expect(body.error).toContain("分析模型未配置");
    expect(requests).toHaveLength(0);
  });

  it("uses the configured OpenRouter analysis model without automatic fallback", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const analyzedRecipe = outdoorReferenceRecipe("recipe_openrouter_configured_test");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ body: requestBody });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(analyzedRecipe)
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return realFetch(input, init);
    });

    const settingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "openrouter",
          activeAnalysisConfig: "openrouter",
          openrouter: {
            apiKey: "sk-or-test",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/gpt-image-2",
            analysisModel: "qwen/qwen2.5-vl-72b-instruct"
          }
        }
      })
    });
    expect(settingsResponse.ok).toBe(true);

    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "third-party"
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { recipe: { scene: string; promptZh: string } };
    expect(body.recipe.scene).toContain("花园");
    expect(requests.map((request) => request.body.model)).toEqual(["qwen/qwen2.5-vl-72b-instruct"]);
  });

  it("creates a mock local generation with gallery output", async () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";

    const providersResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeProvider: "mock" })
    });
    expect(providersResponse.ok).toBe(true);
    const providers = (await providersResponse.json()) as { activeProvider: string };
    expect(providers.activeProvider).toBe("mock");

    const response = await fetch(`${baseUrl}/v1/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        subjects: [{ dataUrl, fileName: "subject.png" }],
        source: { pageTitle: "mock generation" },
        count: 1
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      job: {
        jobId: string;
        status: string;
        providerMode: string;
        durationMs?: number;
        rootDir: string;
        outputs: Array<{ id: string; relativePath: string }>;
      };
    };
    expect(body.job.providerMode).toBe("mock");
    expect(body.job.status).toBe("succeeded");
    expect(body.job.durationMs).toEqual(expect.any(Number));
    expect(body.job.outputs).toHaveLength(1);
    expect(body.job.outputs[0]?.relativePath).toContain("runs/local-jobs/");
    const output = body.job.outputs[0];
    if (!output) throw new Error("Missing generated output");
    const outputPath = path.join(projectRoot, output.relativePath);
    await expect(fs.access(outputPath)).resolves.toBeUndefined();

    const galleryResponse = await fetch(`${baseUrl}/v1/gallery`);
    expect(galleryResponse.ok).toBe(true);
    const gallery = (await galleryResponse.json()) as { jobs: Array<{ jobId: string }> };
    expect(gallery.jobs.some((job) => job.jobId === body.job.jobId)).toBe(true);

    const deleteResponse = await fetch(`${baseUrl}/v1/generations/${body.job.jobId}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageId: output.id, deleted: true })
    });
    expect(deleteResponse.ok).toBe(true);
    await expect(fs.access(outputPath)).resolves.toBeUndefined();

    const hiddenGalleryResponse = await fetch(`${baseUrl}/v1/gallery`);
    const hiddenGallery = (await hiddenGalleryResponse.json()) as {
      jobs: Array<{ jobId: string; outputs: Array<unknown> }>;
    };
    expect(hiddenGallery.jobs.find((job) => job.jobId === body.job.jobId)?.outputs).toHaveLength(0);

    const manifestPath = path.join(projectRoot, body.job.rootDir, "manifest.json");
    const reviewPath = path.join(projectRoot, body.job.rootDir, "review.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { outputs: unknown[] };
    const review = JSON.parse(await fs.readFile(reviewPath, "utf8")) as Record<string, unknown>;
    expect(manifest.outputs).toHaveLength(1);
    expect(review[output.id]).toBeDefined();

    const deleteJobResponse = await fetch(`${baseUrl}/v1/generations/${body.job.jobId}/delete-job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(deleteJobResponse.ok).toBe(true);
    await expect(fs.access(path.join(projectRoot, body.job.rootDir))).resolves.toBeUndefined();

    const finalGalleryResponse = await fetch(`${baseUrl}/v1/gallery`);
    const finalGallery = (await finalGalleryResponse.json()) as { jobs: Array<{ jobId: string }> };
    expect(finalGallery.jobs.some((job) => job.jobId === body.job.jobId)).toBe(false);
  });

  it("switches between configured third-party providers and generates through the selected API", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const analyzedRecipe = outdoorReferenceRecipe("recipe_third_party_test");
    const imageResponseBody = JSON.stringify({
      data: [
        {
          b64_json:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg=="
        }
      ]
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(analyzedRecipe) }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(
          JSON.stringify({
            output_image: {
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==",
              mime_type: "image/png"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(analyzedRecipe)
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://openrouter.ai/api/v1/images") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(imageResponseBody, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://custom.example/v1/chat/completions") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(analyzedRecipe)
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "https://custom.example/v1/images") {
        requests.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(imageResponseBody, { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });

    const settingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeConfig: "geminiNanoBanana",
          activeAnalysisConfig: "geminiNanoBanana",
          geminiNanoBanana: {
            apiKey: "gemini-test-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            model: "gemini-2.5-flash-image",
            analysisModel: "gemini-2.5-flash"
          },
          openrouter: {
            apiKey: "sk-or-test",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "google/gemini-2.5-flash-image-preview",
            analysisModel: "qwen/qwen2.5-vl-72b-instruct"
          },
          custom: {
            apiKey: "custom-test-key",
            baseUrl: "https://custom.example/v1",
            model: "custom-image-model",
            analysisModel: "custom-vision-model"
          }
        }
      })
    });
    expect(settingsResponse.ok).toBe(true);
    const settings = (await settingsResponse.json()) as {
      activeProvider: string;
      activeAnalysisProvider: string;
      providers: Array<{ mode: string; enabled: boolean; status: string; model?: string; keySource?: string }>;
      thirdPartyProviders: Array<{
        key: string;
        enabled: boolean;
        analysisEnabled: boolean;
        activeForGeneration: boolean;
        activeForAnalysis: boolean;
        status: string;
        detail: string;
      }>;
    };
    expect(settings.activeProvider).toBe("third-party");
    expect(settings.activeAnalysisProvider).toBe("third-party");
    expect(settings.providers.find((provider) => provider.mode === "third-party")).toMatchObject({
      enabled: true,
      status: "available",
      model: "gemini-2.5-flash-image",
      keySource: "local-settings"
    });
    expect(settings.thirdPartyProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "geminiNanoBanana",
          enabled: true,
          analysisEnabled: true,
          activeForGeneration: true,
          activeForAnalysis: true,
          status: "available"
        }),
        expect.objectContaining({ key: "openrouter", enabled: true, analysisEnabled: true, status: "available" }),
        expect.objectContaining({ key: "custom", enabled: true, analysisEnabled: true, status: "available" })
      ])
    );

    const geminiAnalysisResponse = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "third-party"
      })
    });
    expect(geminiAnalysisResponse.ok).toBe(true);
    const geminiAnalysis = (await geminiAnalysisResponse.json()) as { recipe: { scene: string; promptZh: string } };
    expect(geminiAnalysis.recipe.scene).toContain("花园");
    expect(geminiAnalysis.recipe.scene).not.toContain("古镇");
    expect(geminiAnalysis.recipe.promptZh).toContain("户外花园");
    expect(requests.at(-1)?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(requests.at(-1)?.headers.get("x-goog-api-key")).toBe("gemini-test-key");
    expect(JSON.stringify(requests.at(-1)?.body)).not.toContain("汉服 古镇");

    const geminiJob = await createThirdPartyGeneration(dataUrl, "gemini generation");
    expect(geminiJob.status).toBe("succeeded");
    expect(requests.at(-1)?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(requests.at(-1)?.headers.get("x-goog-api-key")).toBe("gemini-test-key");
    expect(requests.at(-1)?.body).toMatchObject({
      model: "gemini-2.5-flash-image",
      response_format: expect.objectContaining({ type: "image" })
    });
    expect(requests.at(-1)?.body.input).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image" }),
      expect.objectContaining({ type: "image" })
    ]);
    await deleteGenerationJob(geminiJob.jobId);

    const openRouterSettingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        thirdParty: {
          activeConfig: "openrouter"
        }
      })
    });
    expect(openRouterSettingsResponse.ok).toBe(true);
    const openRouterGenerationSettings = (await openRouterSettingsResponse.json()) as {
      thirdPartyProviders: Array<{ key: string; activeForGeneration: boolean; activeForAnalysis: boolean }>;
    };
    expect(openRouterGenerationSettings.thirdPartyProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "openrouter", activeForGeneration: true, activeForAnalysis: false }),
        expect.objectContaining({ key: "geminiNanoBanana", activeForGeneration: false, activeForAnalysis: true })
      ])
    );
    const openRouterAnalysisSettingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeAnalysisProvider: "third-party",
        thirdParty: {
          activeAnalysisConfig: "openrouter"
        }
      })
    });
    expect(openRouterAnalysisSettingsResponse.ok).toBe(true);
    const openRouterAnalysisResponse = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        source: { pageTitle: "汉服 古镇 夜景旅拍" },
        providerMode: "third-party"
      })
    });
    expect(openRouterAnalysisResponse.ok).toBe(true);
    const openRouterAnalysis = (await openRouterAnalysisResponse.json()) as { recipe: { scene: string } };
    expect(openRouterAnalysis.recipe.scene).toContain("花园");
    expect(requests.at(-1)?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(requests.at(-1)?.body).toMatchObject({
      model: "qwen/qwen2.5-vl-72b-instruct"
    });
    expect(JSON.stringify(requests.at(-1)?.body)).not.toContain("汉服 古镇");

    const openRouterJob = await createThirdPartyGeneration(dataUrl, "openrouter generation");
    expect(openRouterJob.status).toBe("succeeded");
    expect(requests.at(-1)?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(requests.at(-1)?.body).toMatchObject({
      model: "google/gemini-2.5-flash-image-preview",
      output_format: "png"
    });
    expect(requests.at(-1)?.body.input_references).toEqual([
      expect.objectContaining({ type: "image_url" }),
      expect.objectContaining({ type: "image_url" })
    ]);
    await deleteGenerationJob(openRouterJob.jobId);

    const customSettingsResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeProvider: "third-party",
        thirdParty: {
          activeConfig: "custom"
        }
      })
    });
    expect(customSettingsResponse.ok).toBe(true);
    const customJob = await createThirdPartyGeneration(dataUrl, "custom generation");
    expect(customJob.status).toBe("succeeded");
    expect(requests.at(-1)?.url).toBe("https://custom.example/v1/images");
    expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer custom-test-key");
    expect(requests.at(-1)?.body).toMatchObject({
      model: "custom-image-model",
      output_format: "png"
    });
    await deleteGenerationJob(customJob.jobId);
  });

  function outdoorReferenceRecipe(id: string) {
    return {
      id,
      title: "户外花园自然人像",
      subject: "室外中景站姿，人物正面看向镜头，双手自然放松，表情轻松",
      scene: "户外花园步道、绿色灌木和明亮天空背景",
      lighting: "自然日光，面部光线柔和，背景亮度均衡",
      composition: "竖图中景构图，人物位于画面中心，保留上半身和部分环境",
      camera: "手机或微单自然拍摄质感，清晰但不过度修饰",
      color: "绿色植被和浅色服装为主，整体明亮自然",
      outfit: "浅色衬衫和休闲裤，造型简洁日常",
      mood: "自然、轻松、户外生活感",
      negativePrompt: "low quality, blurry, watermark, text, distorted face",
      promptZh:
        "以用户上传的人物图作为身份主体，生成户外花园步道中的自然光中景人像。人物正面看向镜头，身体自然直立，双手轻松放在身前，浅色衬衫和休闲裤保持清爽日常感；背景保留绿色灌木、步道和明亮空气感，面部柔光均匀，整体色彩明亮自然。",
      promptEn:
        "Outdoor garden portrait in natural light. Keep identity from the uploaded subject image and follow this reference for pose, scene, lighting, and composition.",
      tags: ["户外", "花园", "自然光"],
      generationParams: {
        aspectRatio: "3:4",
        identityStrength: 0.86,
        styleStrength: 0.72,
        guidanceScale: 7,
        negativePrompt: "low quality, blurry, watermark, text, distorted face"
      }
    };
  }

  async function createThirdPartyGeneration(
    dataUrl: string,
    pageTitle: string
  ): Promise<{ jobId: string; status: string; providerMode: string; outputs: Array<{ id: string; relativePath: string }> }> {
    const response = await fetch(`${baseUrl}/v1/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "reference.png" },
        subjects: [{ dataUrl, fileName: "subject.png" }],
        source: { pageTitle },
        count: 1
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      job: {
        jobId: string;
        status: string;
        providerMode: string;
        outputs: Array<{ id: string; relativePath: string }>;
      };
    };
    expect(body.job.providerMode).toBe("third-party");
    expect(body.job.outputs).toHaveLength(1);
    const output = body.job.outputs[0];
    if (!output) throw new Error("Missing third-party output");
    await expect(fs.access(path.join(projectRoot, output.relativePath))).resolves.toBeUndefined();
    return body.job;
  }

  async function deleteGenerationJob(jobId: string): Promise<void> {
    const deleteJobResponse = await fetch(`${baseUrl}/v1/generations/${jobId}/delete-job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(deleteJobResponse.ok).toBe(true);
  }

  it("stores provider API settings without returning plaintext keys", async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const previousGeminiKey = process.env.GEMINI_NANO_BANANA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_NANO_BANANA_API_KEY;

    try {
      const openaiKey = `sk-test-${Date.now()}`;
      const geminiKey = `gemini-test-${Date.now()}`;
      const response = await fetch(`${baseUrl}/v1/settings/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openai: {
            apiKey: openaiKey,
            model: "gpt-image-2"
          },
          thirdParty: {
            activeConfig: "geminiNanoBanana",
            geminiNanoBanana: {
              apiKey: geminiKey,
              baseUrl: "https://generativelanguage.googleapis.com",
              model: "gemini-2.5-flash-image"
            },
            openrouter: {
              apiKey: "sk-or-test",
              baseUrl: "https://openrouter.ai/api/v1",
              model: "openai/gpt-image-2",
              analysisModel: ""
            },
            custom: {
              apiKey: "custom-test-key",
              baseUrl: "https://example.test/v1",
              model: "custom-image"
            }
          }
        })
      });
      expect(response.ok).toBe(true);
      const text = await response.text();
      expect(text).not.toContain(openaiKey);
      expect(text).not.toContain(geminiKey);
      expect(text).not.toContain("custom-test-key");

      const body = JSON.parse(text) as {
        providers: Array<{ mode: string; configured: boolean; keySource?: string; model?: string }>;
        thirdPartyProviders: Array<{
          key: string;
          configured: boolean;
          keySource: string;
          baseUrl: string;
          model: string;
          analysisModel: string;
        }>;
      };
      expect(body.providers.find((provider) => provider.mode === "openai-api")).toMatchObject({
        configured: true,
        keySource: "local-settings",
        model: "gpt-image-2"
      });
      expect(body.thirdPartyProviders.find((provider) => provider.key === "geminiNanoBanana")).toMatchObject({
        configured: true,
        keySource: "local-settings",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-2.5-flash-image"
      });
      expect(body.thirdPartyProviders.find((provider) => provider.key === "openrouter")).toMatchObject({
        configured: true,
        keySource: "local-settings",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-image-2",
        analysisModel: ""
      });
      expect(body.thirdPartyProviders.find((provider) => provider.key === "custom")).toMatchObject({
        configured: true,
        keySource: "local-settings",
        baseUrl: "https://example.test/v1",
        model: "custom-image"
      });

      const clearResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openai: { clearApiKey: true },
          thirdParty: {
            custom: { clearApiKey: true }
          }
        })
      });
      expect(clearResponse.ok).toBe(true);
      const clearBody = (await clearResponse.json()) as {
        providers: Array<{ mode: string; configured: boolean; keySource?: string }>;
        thirdPartyProviders: Array<{ key: string; configured: boolean; keySource: string }>;
      };
      expect(clearBody.providers.find((provider) => provider.mode === "openai-api")).toMatchObject({
        configured: false,
        keySource: "none"
      });
      expect(clearBody.thirdPartyProviders.find((provider) => provider.key === "custom")).toMatchObject({
        configured: false,
        keySource: "none"
      });

      await fs.writeFile(
        projectEnvPath,
        [
          "OPENAI_API_KEY=env-openai-test",
          "GEMINI_NANO_BANANA_API_KEY=env-gemini-test",
          "OTHER_KEY=keep-me",
          ""
        ].join("\n"),
        "utf8"
      );
      process.env.OPENAI_API_KEY = "env-openai-test";
      process.env.GEMINI_NANO_BANANA_API_KEY = "env-gemini-test";

      const clearEnvResponse = await fetch(`${baseUrl}/v1/settings/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openai: { clearApiKey: true },
          thirdParty: {
            geminiNanoBanana: { clearApiKey: true }
          }
        })
      });
      expect(clearEnvResponse.ok).toBe(true);
      const envContent = await fs.readFile(projectEnvPath, "utf8");
      expect(envContent).not.toContain("OPENAI_API_KEY");
      expect(envContent).not.toContain("GEMINI_NANO_BANANA_API_KEY");
      expect(envContent).toContain("OTHER_KEY=keep-me");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.GEMINI_NANO_BANANA_API_KEY).toBeUndefined();
    } finally {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      if (previousGeminiKey === undefined) {
        delete process.env.GEMINI_NANO_BANANA_API_KEY;
      } else {
        process.env.GEMINI_NANO_BANANA_API_KEY = previousGeminiKey;
      }
    }
  });
});
