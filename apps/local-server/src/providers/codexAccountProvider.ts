import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  GeneratePortraitInput,
  GeneratePortraitOutput,
  ImageProvider,
  QualityReviewInput,
  QualityReviewOutput,
  StyleRecipe
} from "@styleme/core";
import { DEFAULT_NEGATIVE_PROMPT, buildDefaultGenerationParams, buildRecipeFromHints, validateStyleRecipe } from "@styleme/core";

const DEFAULT_CODEX_ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_CODEX_IMAGE_TIMEOUT_MS = 20 * 60 * 1000;

export class CodexAccountProvider implements ImageProvider {
  async analyzeStyle(imagePathOrUrls: string[]): Promise<StyleRecipe> {
    const imagePath = imagePathOrUrls[0];
    if (!imagePath) {
      return buildRecipeFromHints(`recipe_codex_account_${Date.now()}`, {}, {});
    }

    const recipeId = `recipe_codex_account_${Date.now()}`;
    const cwd = /^https?:\/\//.test(imagePath) ? process.cwd() : path.dirname(imagePath);
    const prompt = buildCodexStyleAnalysisPrompt(recipeId);
    const result = await runCodex(
      [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "-C",
        cwd,
        "--image",
        imagePath,
        "-"
      ],
      cwd,
      prompt,
      codexAnalysisTimeoutMs()
    );
    try {
      return parseCodexRecipeOutput(`${result.stdout}\n${result.stderr}`, recipeId);
    } catch (error) {
      throw new Error(
        `Codex OAuth 原图分析失败。${error instanceof Error ? error.message : String(error)} ${summarizeCodexFailure(result)}`
      );
    }
  }

  async generatePortraits(input: GeneratePortraitInput): Promise<GeneratePortraitOutput> {
    if (!input.outputDirectory) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: "Codex OAuth Provider requires an output directory"
      };
    }

    await fs.mkdir(input.outputDirectory, { recursive: true });
    const jobDir = path.dirname(input.outputDirectory);
    const prompt = buildCodexImagePrompt(input);
    await fs.writeFile(path.join(jobDir, "codex-cli-prompt.md"), prompt, "utf8");

    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-C",
      jobDir,
      ...input.referenceImagePathOrUrls.flatMap((imagePath) => ["--image", imagePath]),
      ...input.subjectImagePathOrUrls.flatMap((imagePath) => ["--image", imagePath]),
      "-"
    ];

    const result = await runCodex(args, jobDir, prompt, codexImageTimeoutMs());
    await fs.writeFile(
      path.join(jobDir, "codex-cli-run.log"),
      [
        `exitCode=${result.exitCode}`,
        `signal=${result.signal ?? ""}`,
        `timedOut=${result.timedOut}`,
        `timeoutMs=${result.timeoutMs}`,
        "",
        "STDOUT:",
        result.stdout,
        "",
        "STDERR:",
        result.stderr
      ].join("\n"),
      "utf8"
    );

    await copyGeneratedImagesFromCodexOutput(`${result.stdout}\n${result.stderr}`, input.outputDirectory, input.count);
    const images = await listOutputImages(input.outputDirectory);
    if (images.length === 0) {
      return {
        jobId: input.jobId,
        status: "failed",
        images: [],
        error: summarizeCodexFailure(result)
      };
    }

    return {
      jobId: input.jobId,
      status: images.length >= input.count ? "succeeded" : "partial_succeeded",
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
            notes: "Codex OAuth/CLI 输出，待人工评分。"
          }
        ])
      )
    };
  }
}

interface CodexRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs: number;
  stdout: string;
  stderr: string;
}

function buildCodexImagePrompt(input: GeneratePortraitInput): string {
  const count = Math.max(1, Math.min(4, input.count));
  return [
    "# Codex OAuth Image Generation Job",
    "",
    "Use the attached images directly. Image 1 is the style/reference photo. The remaining attached image(s) are the subject/person reference.",
    "Generate real bitmap portrait photo output. Do not create placeholders, SVG, HTML, gradients, diagrams, or text-only files.",
    "Use Codex built-in image generation / $imagegen when available.",
    "",
    `Output exactly ${count} PNG image file(s).`,
    "Save them into the local ./output directory with these exact names:",
    ...Array.from({ length: count }, (_, index) => `- image-${String(index + 1).padStart(2, "0")}.png`),
    "",
    "If image generation saves files under CODEX_HOME/generated_images, copy the selected final PNG files into ./output before finishing.",
    "After the requested PNG files exist in ./output, stop immediately. Do not run visual checks, image previews, or extra validation commands.",
    "",
    "Generation requirements:",
    "- Preserve the main facial features, face shape, hair direction, and natural presence from the subject/person image.",
    `- Match the reference pose/body arrangement when appropriate: ${input.recipe.subject}`,
    `- Match the reference outfit/styling direction when appropriate: ${input.recipe.outfit}`,
    "- Transfer the lighting, color, camera feel, scene mood, and composition from the reference photo.",
    "- Do not copy the identity of the person in the reference photo.",
    "- No watermark, no text, no explicit content, no distorted face, no extra limbs.",
    "",
    "Style recipe:",
    JSON.stringify(input.recipe, null, 2),
    "",
    "Final response: list only the files saved in ./output, or explain why no PNG could be saved."
  ].join("\n");
}

function buildCodexStyleAnalysisPrompt(recipeId: string): string {
  return [
    "# StyleRecipe Image Analysis",
    "",
    "Analyze the attached reference image and return only one valid JSON object. Do not use Markdown fences.",
    "Do not identify or name any person in the image. Describe visible style only.",
    "",
    "Required JSON shape:",
    "{",
    `  \"id\": \"${recipeId}\",`,
    "  \"title\": \"short Chinese title\",",
    "  \"subject\": \"Chinese description of visible pose, body angle, head direction, hand placement, framing, and expression; keep it identity-neutral\",",
    "  \"scene\": \"Chinese scene/background description\",",
    "  \"lighting\": \"Chinese lighting description\",",
    "  \"composition\": \"Chinese composition/framing description\",",
    "  \"camera\": \"Chinese camera/lens/texture description\",",
    "  \"color\": \"Chinese color grading description\",",
    "  \"outfit\": \"Chinese clothing, hairstyle, makeup, accessories, props, and styling description\",",
    "  \"mood\": \"Chinese mood description\",",
    "  \"negativePrompt\": \"English negative prompt\",",
    "  \"promptZh\": \"Chinese generation prompt that includes pose, outfit, lighting, scene, color, and identity-preservation instruction\",",
    "  \"promptEn\": \"English generation prompt with the same constraints\",",
    "  \"tags\": [\"Chinese tag\"],",
    "  \"generationParams\": {",
    "    \"aspectRatio\": \"1:1 | 3:4 | 4:5 | 9:16\",",
    "    \"identityStrength\": 0.86,",
    "    \"styleStrength\": 0.72,",
    "    \"guidanceScale\": 7,",
    "    \"negativePrompt\": \"English negative prompt\"",
    "  }",
    "}",
    "",
    "The subject field is for pose and body arrangement. The outfit field is for clothing/styling. The generated person's face identity must come from the user-uploaded subject image, not from this reference image."
  ].join("\n");
}

function runCodex(args: string[], cwd: string, stdin: string, timeoutMs: number): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const child = spawn("codex", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.end(stdin);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, signal: null, timedOut, timeoutMs, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, timeoutMs, stdout, stderr });
    });
  });
}

async function copyGeneratedImagesFromCodexOutput(text: string, outputDirectory: string, count: number): Promise<void> {
  const existing = await listOutputImages(outputDirectory);
  if (existing.length >= count) return;

  const candidates = [...text.matchAll(/(?:file:\/\/)?(\/[^\s'"`)\]]+\.(?:png|jpe?g|webp))/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .filter((value, index, list) => list.indexOf(value) === index);

  let nextIndex = existing.length + 1;
  for (const candidate of candidates) {
    if (nextIndex > count) return;
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      const fileName = `image-${String(nextIndex).padStart(2, "0")}${path.extname(candidate).toLowerCase() || ".png"}`;
      await fs.copyFile(candidate, path.join(outputDirectory, fileName));
      nextIndex += 1;
    } catch {
      // Ignore paths printed by Codex that are not accessible on disk.
    }
  }
}

async function listOutputImages(outputDirectory: string): Promise<GeneratePortraitOutput["images"]> {
  try {
    const files = (await fs.readdir(outputDirectory))
      .filter((fileName) => /\.(png|jpe?g|webp)$/i.test(fileName))
      .sort();
    return files.map((fileName) => ({
      id: path.parse(fileName).name,
      pathOrUrl: path.join(outputDirectory, fileName)
    }));
  } catch {
    return [];
  }
}

function summarizeCodexFailure(result: CodexRunResult): string {
  const text = stripAnsi(`${result.stdout}\n${result.stderr}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(" ");
  if (result.timedOut) {
    return `Codex CLI 超时（${formatDuration(result.timeoutMs)}），未保存 PNG。`;
  }
  if (result.exitCode === null) {
    return result.signal ? `Codex CLI 被 ${result.signal} 终止，未保存 PNG。` : "Codex CLI 被终止，未保存 PNG。";
  }
  return text
    ? `Codex CLI 未保存 PNG。退出码 ${result.exitCode}。${text}`
    : `Codex CLI 未保存 PNG。退出码 ${result.exitCode}。`;
}

function codexAnalysisTimeoutMs(): number {
  return readTimeoutMs("STYLEME_CODEX_ANALYSIS_TIMEOUT_MS", DEFAULT_CODEX_ANALYSIS_TIMEOUT_MS);
}

function codexImageTimeoutMs(): number {
  return readTimeoutMs("STYLEME_CODEX_IMAGE_TIMEOUT_MS", DEFAULT_CODEX_IMAGE_TIMEOUT_MS);
}

function readTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}分${String(rest).padStart(2, "0")}秒` : `${minutes}分钟`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseCodexRecipeOutput(text: string, recipeId: string): StyleRecipe {
  const parsed = parseFirstRecipeLikeJson(stripAnsi(text));
  const aspectRatio = normalizeAspectRatio(parsed.generationParams?.aspectRatio);
  const generationParams = {
    ...buildDefaultGenerationParams(aspectRatio),
    negativePrompt: stringValue(parsed.generationParams?.negativePrompt, stringValue(parsed.negativePrompt, DEFAULT_NEGATIVE_PROMPT))
  };
  assignNumber(generationParams, "seed", parsed.generationParams?.seed);
  assignNumber(generationParams, "strength", parsed.generationParams?.strength);
  assignNumber(generationParams, "guidanceScale", parsed.generationParams?.guidanceScale);
  assignNumber(generationParams, "identityStrength", parsed.generationParams?.identityStrength);
  assignNumber(generationParams, "styleStrength", parsed.generationParams?.styleStrength);

  const recipe: StyleRecipe = {
    id: stringValue(parsed.id, recipeId),
    title: stringValue(parsed.title, "参考图风格写真"),
    subject: stringValue(parsed.subject, "参考图人物姿势：保持头部朝向、手臂位置、身体角度和景别关系"),
    scene: stringValue(parsed.scene, "参考图中的主要环境与空间关系"),
    lighting: stringValue(parsed.lighting, "延续参考图的主光方向、阴影强度和环境光比例"),
    composition: stringValue(parsed.composition, "保持参考图的景别、人物位置和背景留白关系"),
    camera: stringValue(parsed.camera, "真实摄影质感，清晰自然，不过度磨皮"),
    color: stringValue(parsed.color, "参考图的整体色温、饱和度和明暗对比"),
    outfit: stringValue(parsed.outfit, "参考图中的服装、发型、妆造、配饰和道具风格"),
    mood: stringValue(parsed.mood, "自然、真实、适合个人写真"),
    negativePrompt: stringValue(parsed.negativePrompt, DEFAULT_NEGATIVE_PROMPT),
    promptZh: stringValue(
      parsed.promptZh,
      "参考图用于提取姿势、服装造型、光线、构图、场景和色彩；人物身份以用户上传的人物图为准。"
    ),
    promptEn: stringValue(
      parsed.promptEn,
      "Use the reference image for pose, outfit styling, lighting, composition, scene, and color. Keep the identity from the uploaded subject image."
    ),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : ["网页参考"],
    generationParams
  };

  if (!validateStyleRecipe(recipe)) {
    throw new Error("Codex returned an incomplete StyleRecipe JSON.");
  }
  return recipe;
}

function parseFirstRecipeLikeJson(value: string): Partial<StyleRecipe> & { generationParams?: Record<string, unknown> } {
  for (const candidate of findJsonObjectCandidates(value)) {
    try {
      const parsed = JSON.parse(candidate) as Partial<StyleRecipe> & { generationParams?: Record<string, unknown> };
      if (parsed && typeof parsed === "object" && typeof parsed.title === "string") {
        return parsed;
      }
    } catch {
      // Try the next balanced JSON-looking block in the CLI output.
    }
  }
  throw new Error("No valid StyleRecipe JSON object was found in Codex output.");
}

function findJsonObjectCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(value.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeAspectRatio(value: unknown): "1:1" | "3:4" | "4:5" | "9:16" {
  return value === "1:1" || value === "3:4" || value === "4:5" || value === "9:16" ? value : "4:5";
}

function assignNumber<T extends Record<string, unknown>>(target: T, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key as keyof T] = value as T[keyof T];
  }
}
