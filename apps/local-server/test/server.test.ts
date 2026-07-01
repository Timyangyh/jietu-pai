import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("local server", () => {
  it("returns local service health status", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; activeProvider: string };
    expect(body.ok).toBe(true);
    expect(body.activeProvider).toBeTruthy();
  });

  it("analyzes a reference image data URL into a complete recipe", async () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWZ2wAAAABJRU5ErkJggg==";
    const response = await fetch(`${baseUrl}/v1/recipes/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reference: { dataUrl, fileName: "summer.png" },
        source: { pageTitle: "summer green outdoor" }
      })
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { recipe: { title: string; promptZh: string } };
    expect(body.recipe.title).toContain("夏日");
    expect(body.recipe.promptZh).toContain("人物图");
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
        thirdPartyProviders: Array<{ key: string; configured: boolean; keySource: string; baseUrl: string; model: string }>;
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
