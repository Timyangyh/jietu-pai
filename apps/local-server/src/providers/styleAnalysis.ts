import type { AspectRatio, StyleRecipe } from "@styleme/core";
import {
  DEFAULT_NEGATIVE_PROMPT,
  buildDefaultGenerationParams,
  buildRecipeFromHints,
  validateStyleRecipe
} from "@styleme/core";

export function buildReferenceAnalysisPrompt(recipeId: string): string {
  return [
    "You are a senior portrait photography prompt engineer. Analyze only the attached reference image pixels.",
    "Ignore webpage title, surrounding article text, filenames, source URL, and any unrelated context.",
    "Return only one valid JSON object. Do not use Markdown fences, comments, explanations, or extra keys.",
    "Do not identify or name any person. Describe visible style only.",
    "Every Chinese field must be concrete and directly observable. Do not write generic placeholders.",
    "Forbidden generic wording includes: 参考图中的主要环境, 主要环境与空间关系, 延续参考图, 保持参考图, 与参考图氛围一致, 整体色温, 明暗对比, 简洁穿搭.",
    "",
    "Detail requirements:",
    "- subject: 4-6 concrete visible details covering shot size, body direction, head/gaze direction, hand/arm placement, posture, expression.",
    "- scene: concrete foreground/midground/background elements, location type, visible props or environment texture.",
    "- lighting: light source direction, hardness/softness, shadow placement, face/background brightness relation.",
    "- composition: crop, subject placement, camera angle, depth/layering, negative space, background relationship.",
    "- camera: lens or phone/camera feel, depth of field, grain/sharpness, realism/retouching level.",
    "- color: dominant colors, saturation, contrast, color temperature, skin/background balance.",
    "- outfit: visible clothing pieces, fabric/material feel, colors, hairstyle, accessories, props, styling attitude.",
    "- promptZh: 180-260 Chinese characters, production-ready, specific enough to generate a similar portrait while keeping identity from the uploaded subject image.",
    "- promptEn: concise English version with the same concrete constraints.",
    "",
    "Required JSON shape:",
    "{",
    `  \"id\": \"${recipeId}\",`,
    "  \"title\": \"short Chinese title\",",
    "  \"subject\": \"specific Chinese shot size, pose, body angle, gaze/head direction, hand placement, expression\",",
    "  \"scene\": \"specific Chinese visible location, foreground/midground/background elements, props, environment texture\",",
    "  \"lighting\": \"specific Chinese light source direction, softness, shadows, face/background brightness\",",
    "  \"composition\": \"specific Chinese crop, subject placement, camera angle, depth/layering, background relation\",",
    "  \"camera\": \"specific Chinese lens/camera/phone feel, depth of field, grain, sharpness, retouching level\",",
    "  \"color\": \"specific Chinese dominant colors, saturation, contrast, color temperature, skin/background balance\",",
    "  \"outfit\": \"specific Chinese visible clothes, material, color, hair, accessories, props, styling attitude\",",
    "  \"mood\": \"Chinese mood description\",",
    "  \"negativePrompt\": \"English negative prompt\",",
    "  \"promptZh\": \"Chinese generation prompt that says identity comes from the user-uploaded subject image, while pose, outfit styling, lighting, scene, color, and composition come from this reference image\",",
    "  \"promptEn\": \"English generation prompt with the same constraints\",",
    "  \"tags\": [\"Chinese tag\"],",
    "  \"generationParams\": {",
    "    \"aspectRatio\": \"1:1 | 3:4 | 4:5 | 9:16\",",
    "    \"identityStrength\": 0.86,",
    "    \"styleStrength\": 0.72,",
    "    \"guidanceScale\": 7,",
    "    \"negativePrompt\": \"English negative prompt\"",
    "  }",
    "}"
  ].join("\n");
}

export function neutralReferenceRecipe(recipeId: string): StyleRecipe {
  return buildRecipeFromHints(recipeId, {}, {});
}

export function parseStyleRecipeText(text: string, recipeId: string): StyleRecipe {
  const parsed = parseFirstRecipeJson(text);
  const aspectRatio = normalizeAspectRatio(parsed.generationParams?.aspectRatio);
  const generationParams: StyleRecipe["generationParams"] = {
    ...buildDefaultGenerationParams(aspectRatio),
    negativePrompt: stringValue(parsed.generationParams?.negativePrompt, stringValue(parsed.negativePrompt, DEFAULT_NEGATIVE_PROMPT))
  };
  const seed = numberValue(parsed.generationParams?.seed);
  const strength = numberValue(parsed.generationParams?.strength);
  const guidanceScale = numberValue(parsed.generationParams?.guidanceScale);
  const identityStrength = numberValue(parsed.generationParams?.identityStrength);
  const styleStrength = numberValue(parsed.generationParams?.styleStrength);
  if (seed !== undefined) generationParams.seed = seed;
  if (strength !== undefined) generationParams.strength = strength;
  if (guidanceScale !== undefined) generationParams.guidanceScale = guidanceScale;
  if (identityStrength !== undefined) generationParams.identityStrength = identityStrength;
  if (styleStrength !== undefined) generationParams.styleStrength = styleStrength;

  const recipe: StyleRecipe = {
    id: stringValue(parsed.id, recipeId),
    title: requiredString(parsed.title, "title"),
    subject: requiredString(parsed.subject, "subject"),
    scene: requiredString(parsed.scene, "scene"),
    lighting: requiredString(parsed.lighting, "lighting"),
    composition: requiredString(parsed.composition, "composition"),
    camera: requiredString(parsed.camera, "camera"),
    color: requiredString(parsed.color, "color"),
    outfit: requiredString(parsed.outfit, "outfit"),
    mood: requiredString(parsed.mood, "mood"),
    negativePrompt: stringValue(parsed.negativePrompt, DEFAULT_NEGATIVE_PROMPT),
    promptZh: requiredString(parsed.promptZh, "promptZh"),
    promptEn: requiredString(parsed.promptEn, "promptEn"),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : ["参考图"],
    generationParams
  };

  if (!validateStyleRecipe(recipe)) throw new Error("StyleRecipe JSON is missing required fields.");
  assertDetailedRecipe(recipe);
  return recipe;
}

function parseFirstRecipeJson(text: string): Partial<StyleRecipe> & { generationParams?: Record<string, unknown> } {
  for (const candidate of findJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const recipe = extractRecipeObject(parsed);
      if (recipe) return recipe;
    } catch {
      // Try the next balanced JSON-looking block.
    }
  }
  throw new Error("No valid StyleRecipe JSON object was found in analysis output.");
}

function extractRecipeObject(value: unknown): (Partial<StyleRecipe> & { generationParams?: Record<string, unknown> }) | undefined {
  if (!value || typeof value !== "object") return undefined;
  const objectValue = value as Record<string, unknown>;
  if (typeof objectValue.title === "string") {
    return objectValue as Partial<StyleRecipe> & { generationParams?: Record<string, unknown> };
  }
  return extractRecipeObject(objectValue.recipe);
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
      } else if (char === "{") {
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

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`StyleRecipe field "${field}" is missing or empty.`);
}

function assertDetailedRecipe(recipe: StyleRecipe): void {
  const fields: Array<[keyof StyleRecipe, string, number]> = [
    ["subject", recipe.subject, 24],
    ["scene", recipe.scene, 14],
    ["lighting", recipe.lighting, 14],
    ["composition", recipe.composition, 16],
    ["camera", recipe.camera, 12],
    ["color", recipe.color, 12],
    ["outfit", recipe.outfit, 14],
    ["promptZh", recipe.promptZh, 80]
  ];
  for (const [field, value, minLength] of fields) {
    if (value.length < minLength || isGenericAnalysisText(value)) {
      throw new Error(`StyleRecipe field "${field}" is too generic: ${value}`);
    }
  }
}

function isGenericAnalysisText(value: string): boolean {
  return /参考图中(?:的)?主要环境|主要环境与空间关系|延续参考图|保持参考图|与参考图氛围一致|整体色温|明暗对比|简洁穿搭|可见服装、发型、配饰|真实摄影质感，清晰自然/.test(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAspectRatio(value: unknown): AspectRatio {
  if (value === "1:1" || value === "3:4" || value === "4:5" || value === "9:16") return value;
  return "4:5";
}
