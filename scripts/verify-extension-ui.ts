import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createStyleMeServer } from "../apps/local-server/src/server";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = path.join(projectRoot, "照样拍插件-本地加载版");
const fixtureRoot = path.join(projectRoot, "apps/extension/fixtures/pages");
const screenshotDir = path.join(projectRoot, ".tmp/verification");
const subjectFixturePath = path.join(projectRoot, ".tmp/verification-subject.png");
const localApiPort = 8787;
const fixturePort = 8899;

await fs.mkdir(screenshotDir, { recursive: true });
await ensureExtensionBuild(extensionPath);
await ensureSubjectFixture(subjectFixturePath);

const localServer = await startLocalApiIfNeeded();
const originalProviders = await getActiveProvidersForVerification();
const originalGalleryJobIds = await getVisibleGalleryJobIds();
await configureMockProviders();

const fixtureServer = createFixtureServer(fixtureRoot);
fixtureServer.listen(fixturePort, "127.0.0.1");
await once(fixtureServer, "listening");

let context: BrowserContext | undefined;
try {
  context = await chromium.launchPersistentContext(path.join(projectRoot, ".tmp/playwright-profile"), {
    headless: false,
    viewport: { width: 1366, height: 768 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${fixturePort}/ordinary-image.html`);
  await page.locator("img").first().hover({ position: { x: 180, y: 200 } });
  await shadowTestId(page, "select-reference").click();
  await shadowTestId(page, "analyze-reference").click();
  await waitForShadowText(page, "图片配方", 8000);

  await shadowTestId(page, "subject-upload-input").setInputFiles(subjectFixturePath);

  await shadowTestId(page, "start-generation").click();
  await waitForShadowText(page, "生成完成", 10000);
  await page.screenshot({ path: path.join(screenshotDir, "extension-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, "extension-mobile.png"), fullPage: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshots: [
          ".tmp/verification/extension-desktop.png",
          ".tmp/verification/extension-mobile.png"
        ]
      },
      null,
      2
    )
  );
} finally {
  await cleanupVerificationJobs(originalGalleryJobIds);
  await restoreActiveProviders(originalProviders);
  await context?.close();
  fixtureServer.close();
  if (localServer) localServer.close();
  await Promise.allSettled([
    localServer ? once(localServer, "close") : Promise.resolve(),
    once(fixtureServer, "close")
  ]);
}

async function waitForShadowText(page: Page, text: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector("styleme-local-overlay")?.shadowRoot?.textContent?.includes(expected),
    text,
    { timeout }
  );
}

function shadowTestId(page: Page, testId: string) {
  return page.locator(`styleme-local-overlay [data-testid="${testId}"]`);
}

async function ensureSubjectFixture(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const onePixelPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  await fs.writeFile(filePath, Buffer.from(onePixelPng, "base64"));
}

async function ensureExtensionBuild(directory: string): Promise<void> {
  try {
    await fs.access(path.join(directory, "manifest.json"));
  } catch {
    throw new Error("未找到根目录插件 manifest.json。请先运行 pnpm build:extension。");
  }
}

async function startLocalApiIfNeeded(): Promise<http.Server | undefined> {
  const server = createStyleMeServer({ port: localApiPort });
  try {
    const started = new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", (error) => reject(error));
    });
    server.listen(localApiPort, "127.0.0.1");
    await started;
    return server;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const response = await fetch(`http://127.0.0.1:${localApiPort}/health`);
    if (!response.ok) throw new Error(`Existing local API is not healthy: ${response.status}`);
    return undefined;
  }
}

async function configureMockProviders(): Promise<void> {
  await setActiveProviders({ activeProvider: "mock", activeAnalysisProvider: "mock" });
}

async function getActiveProvidersForVerification(): Promise<{ activeProvider: string; activeAnalysisProvider: string }> {
  const response = await fetch(`http://127.0.0.1:${localApiPort}/v1/settings/providers`);
  if (!response.ok) return { activeProvider: "mock", activeAnalysisProvider: "mock" };
  const body = (await response.json()) as { activeProvider?: string; activeAnalysisProvider?: string };
  return {
    activeProvider: body.activeProvider ?? "mock",
    activeAnalysisProvider: body.activeAnalysisProvider ?? body.activeProvider ?? "mock"
  };
}

async function restoreActiveProviders(providers: { activeProvider: string; activeAnalysisProvider: string }): Promise<void> {
  try {
    await setActiveProviders(providers);
  } catch {
    // Verification cleanup should not mask the UI failure that may already be in flight.
  }
}

async function getVisibleGalleryJobIds(): Promise<Set<string>> {
  try {
    const response = await fetch(`http://127.0.0.1:${localApiPort}/v1/gallery`);
    if (!response.ok) return new Set();
    const body = (await response.json()) as { jobs?: Array<{ jobId?: string }> };
    return new Set((body.jobs ?? []).map((job) => job.jobId).filter((jobId): jobId is string => Boolean(jobId)));
  } catch {
    return new Set();
  }
}

async function cleanupVerificationJobs(originalJobIds: Set<string>): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${localApiPort}/v1/gallery`);
    if (!response.ok) return;
    const body = (await response.json()) as {
      jobs?: Array<{ jobId?: string; providerMode?: string; rootDir?: string }>;
    };
    const newMockJobs = (body.jobs ?? []).filter(
      (job) => job.jobId && !originalJobIds.has(job.jobId) && job.providerMode === "mock"
    );
    const newMockJobIds = newMockJobs.map((job) => job.jobId as string);
    if (newMockJobIds.length === 0) return;

    const clearResponse = await fetch(`http://127.0.0.1:${localApiPort}/v1/gallery/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobIds: newMockJobIds })
    });
    if (!clearResponse.ok) {
      await Promise.allSettled(
        newMockJobIds.map((jobId) =>
          fetch(`http://127.0.0.1:${localApiPort}/v1/generations/${encodeURIComponent(jobId)}/delete-job`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
        )
      );
    }

    await Promise.allSettled(newMockJobs.map((job) => removeVerificationJobDirectory(job.rootDir)));
  } catch {
    // Verification cleanup should not mask the UI failure that may already be in flight.
  }
}

async function removeVerificationJobDirectory(rootDir: string | undefined): Promise<void> {
  if (!rootDir) return;
  const localJobsRoot = path.join(projectRoot, "runs", "local-jobs");
  const jobRoot = path.resolve(projectRoot, rootDir);
  if (!jobRoot.startsWith(`${localJobsRoot}${path.sep}`)) return;
  await fs.rm(jobRoot, { recursive: true, force: true });
}

async function setActiveProviders(providers: { activeProvider: string; activeAnalysisProvider: string }): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${localApiPort}/v1/settings/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(providers)
  });
  if (!response.ok) {
    throw new Error(`Could not set provider for UI verification: ${response.status}`);
  }
}

function createFixtureServer(root: string): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const target = path.resolve(root, url.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    try {
      const body = await fs.readFile(target);
      response.writeHead(200, {
        "content-type": target.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream"
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
}
