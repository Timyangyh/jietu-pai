import type { GeneratePortraitInput, QualityReviewInput, StyleRecipe } from "@styleme/core";

export function buildStyleAnalysisPrompt(): string {
  return [
    "# Style Analysis",
    "",
    "从参考图中提取摄影风格，输出 StyleRecipe JSON。",
    "必须包含人物姿势和服装造型：人物姿势写入 subject，服装、发型、妆造、配饰和道具写入 outfit。",
    "只描述风格、场景、构图、光线、色彩、人物姿势、服装造型和氛围，不复制参考图人物身份。",
    "StyleRecipe 只作为解释和提示词补充，生图主输入仍必须包含参考图和人物图。"
  ].join("\n");
}

export function buildGenerationPrompt(input: GeneratePortraitInput): string {
  const recipe = JSON.stringify(input.recipe, null, 2);
  const referenceFiles = input.referenceImagePathOrUrls.map(fileBaseName).join(", ");
  const subjectFiles = input.subjectImagePathOrUrls.map(fileBaseName).join(", ");
  const referenceOrder = imageOrderLabel(1, input.referenceImagePathOrUrls.length);
  const subjectOrder = imageOrderLabel(
    input.referenceImagePathOrUrls.length + 1,
    input.referenceImagePathOrUrls.length + input.subjectImagePathOrUrls.length
  );
  return [
    "# Generation Job",
    "",
    `请基于 ${referenceFiles} 的摄影风格，将 ${subjectFiles} 中的人物生成成同风格写真。`,
    "",
    "## 输入文件",
    "",
    `- ${referenceFiles}：摄影风格参考图`,
    `- ${subjectFiles}：人物主体参考图`,
    "- recipe.json：结构化图片配方，仅作为补充约束",
    "",
    "## 图片顺序与身份优先级",
    "",
    `- ${referenceOrder}（${referenceFiles}）：只用于摄影风格、姿势、身体角度、手部位置、光线、构图、色彩、服装氛围和场景关系；不得使用其中人物的脸、五官、脸型或身份。`,
    `- ${subjectOrder}（${subjectFiles}）：人物身份唯一来源；必须优先保持其主要面部特征、脸型、发型方向和人物气质。`,
    "- 当风格参考图和人物图冲突时，以人物图身份为准。",
    "",
    "## 生成要求",
    "",
    `1. 输出 ${input.count} 张 ${input.recipe.generationParams.aspectRatio} 竖图，命名为 image-01.png、image-02.png。`,
    `2. 保持 ${subjectFiles} 的主要面部特征、发型方向和人物气质。`,
    `3. 参考 ${referenceFiles} 的人物姿势、身体角度、手部位置、光线、构图、色彩、服装氛围和场景关系。`,
    `4. 服装造型参考 recipe.outfit，但人脸身份以 ${subjectFiles} 为准。`,
    `5. 不复制 ${referenceFiles} 中具体人物身份、五官和脸型。`,
    "6. 避免露骨、冒充、侵权、水印、文字、畸形、多余肢体和明显换脸。",
    "",
    "## 图片配方",
    "",
    "```json",
    recipe,
    "```",
    "",
    "## 中文提示词",
    "",
    input.recipe.promptZh,
    "",
    "## English Prompt",
    "",
    input.recipe.promptEn,
    "",
    "## Negative Prompt",
    "",
    input.recipe.negativePrompt
  ].join("\n");
}

export function buildReviewPrompt(input: QualityReviewInput): string {
  const recipe = JSON.stringify(input.recipe, null, 2);
  return [
    "# Quality Review",
    "",
    "请对 output/ 下的生成图评分，并写入 review.json。",
    "",
    "评分字段：",
    "- styleScore: 1-5，光线、构图、色彩、场景是否接近参考图。",
    "- identityScore: 1-5，是否保留人物图主要脸部特征。",
    "- qualityScore: 1-5，是否清晰、自然、无明显畸形。",
    "- usabilityScore: 1-5，用户是否愿意保存。",
    "- risk: pass / fail / unknown。",
    "- failureReasons: 字符串数组。",
    "",
    "可以先人工评分；如需严谨对比，可自行增加客观指标和更多样本。",
    "",
    "## 图片配方",
    "",
    "```json",
    recipe,
    "```"
  ].join("\n");
}

export function summarizeRecipeForUi(recipe: StyleRecipe): string {
  return [recipe.scene, recipe.lighting, recipe.composition, recipe.color]
    .filter(Boolean)
    .join("；");
}

function fileBaseName(value: string): string {
  const withoutQuery = value.split("?")[0] ?? value;
  return withoutQuery.split(/[\\/]/).pop() || value;
}

function imageOrderLabel(start: number, end: number): string {
  return start === end ? `第 ${start} 张图` : `第 ${start}-${end} 张图`;
}
