import type { AspectRatio, GenerationParams, StyleRecipe } from "./provider.types";

export interface ImageMeta {
  width?: number;
  height?: number;
  mimeType?: string;
  byteLength?: number;
}

export interface StyleHint {
  altText?: string;
  fileName?: string;
  pageTitle?: string;
  pageUrl?: string;
  sourceUrl?: string;
}

const REQUIRED_STYLE_FIELDS: Array<keyof StyleRecipe> = [
  "id",
  "title",
  "subject",
  "scene",
  "lighting",
  "composition",
  "camera",
  "color",
  "outfit",
  "mood",
  "negativePrompt",
  "promptZh",
  "promptEn",
  "tags",
  "generationParams"
];

export const DEFAULT_NEGATIVE_PROMPT =
  "low quality, blurry, distorted face, extra fingers, extra limbs, deformed hands, changed identity, explicit content, watermark, text";

export function validateStyleRecipe(recipe: unknown): recipe is StyleRecipe {
  if (!recipe || typeof recipe !== "object") return false;
  const value = recipe as Partial<StyleRecipe>;
  const hasRequiredFields = REQUIRED_STYLE_FIELDS.every((field) => field in value);
  if (!hasRequiredFields) return false;
  if (!Array.isArray(value.tags)) return false;
  const params = value.generationParams;
  return Boolean(params && typeof params === "object" && params.aspectRatio && params.negativePrompt);
}

export function ensureStyleRecipe(recipe: StyleRecipe): StyleRecipe {
  if (!validateStyleRecipe(recipe)) {
    throw new Error("StyleRecipe is missing required fields");
  }
  return recipe;
}

export function buildDefaultGenerationParams(aspectRatio: AspectRatio = "4:5"): GenerationParams {
  return {
    aspectRatio,
    identityStrength: 0.86,
    styleStrength: 0.72,
    guidanceScale: 7,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT
  };
}

export function inferAspectRatio(meta: ImageMeta): AspectRatio {
  if (!meta.width || !meta.height) return "4:5";
  const ratio = meta.width / meta.height;
  if (ratio > 0.95 && ratio < 1.05) return "1:1";
  if (ratio > 0.72 && ratio < 0.8) return "3:4";
  if (ratio > 0.77 && ratio < 0.86) return "4:5";
  if (ratio < 0.62) return "9:16";
  return "4:5";
}

export function buildRecipeFromHints(id: string, meta: ImageMeta, hint: StyleHint = {}): StyleRecipe {
  const haystack = [
    hint.altText,
    hint.fileName,
    hint.pageTitle,
    hint.pageUrl,
    hint.sourceUrl
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const preset = pickPreset(haystack);
  const aspectRatio = inferAspectRatio(meta);
  const subject = `以用户上传的人物图为主体，保持本人主要脸部特征和自然表情；参考图人物姿势：${preset.pose}`;
  const promptZh = [
    `参考图风格：${preset.scene}，${preset.lighting}，${preset.composition}。`,
    `人物姿势：${preset.pose}。`,
    `服装造型：${preset.outfit}。`,
    `生成时保留人物图的主要脸部特征、发型方向和自然气质。`,
    `色彩和质感：${preset.color}；相机感觉：${preset.camera}。`,
    `不要复制参考图中的具体人物身份，只参考摄影风格。`
  ].join("");

  const promptEn = [
    `Use the reference image for photographic style: ${preset.scene}, ${preset.lighting}, ${preset.composition}.`,
    `Reference pose: ${preset.pose}.`,
    `Outfit and styling: ${preset.outfit}.`,
    "Keep the main facial features, hair direction, and natural presence from the subject image.",
    `Color and texture: ${preset.color}. Camera feel: ${preset.camera}.`,
    "Do not copy the identity of any person in the reference image; only transfer the photographic style."
  ].join(" ");

  return {
    id,
    title: preset.title,
    subject,
    scene: preset.scene,
    lighting: preset.lighting,
    composition: preset.composition,
    camera: preset.camera,
    color: preset.color,
    outfit: preset.outfit,
    mood: preset.mood,
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    promptZh,
    promptEn,
    tags: preset.tags,
    generationParams: buildDefaultGenerationParams(aspectRatio)
  };
}

interface RecipePreset {
  title: string;
  pose: string;
  scene: string;
  lighting: string;
  composition: string;
  camera: string;
  color: string;
  outfit: string;
  mood: string;
  tags: string[];
}

function pickPreset(text: string): RecipePreset {
  if (/(hanfu|汉服|古镇|簪花|妆造|旅拍|甘坑)/i.test(text)) {
    return {
      title: "古风汉服旅拍写真",
      pose: "半身或中景正面，头部略微侧转，一只手靠近额头或脸侧，另一只手自然持花、扶袖或放在身前",
      scene: "古镇、夜景建筑或中式园林环境，背景有灯光、水面或木质建筑层次",
      lighting: "夜景环境光叠加正面柔光，面部明亮，背景灯光保留氛围",
      composition: "竖图中景或半身，人像位于画面中心，头饰、袖摆和手部姿势完整入画",
      camera: "手机或旅拍相机质感，面部清晰，适度修饰但保留真实皮肤细节",
      color: "粉白、浅金和暖色灯光为主，背景暗部压低，人物服装更亮",
      outfit: "汉服或古风服装，发饰、头冠、珠链、披帛、花束等造型元素清晰但不过度堆叠",
      mood: "甜美、精致、古风旅拍感",
      tags: ["汉服", "古镇", "旅拍", "夜景"]
    };
  }

  if (/(y2k|flash|night|夜|闪光|club|party)/i.test(text)) {
    return {
      title: "夜间闪光感写真",
      pose: "半身近景，身体微侧，面向镜头，手部可自然放在脸侧、头发旁或身体前方",
      scene: "夜间街头或室内暗部环境，背景保留少量环境光",
      lighting: "正面闪光灯为主，脸部清晰，背景略暗",
      composition: "半身或近景竖图，人物居中，保留少量肩部和背景氛围",
      camera: "手机闪光或 CCD 直闪质感，轻微锐化，真实抓拍",
      color: "高对比，肤色偏暖，暗部略带蓝黑色",
      outfit: "适合夜景氛围的简洁上衣或轻微 Y2K 穿搭",
      mood: "自信、随性、夜拍氛围",
      tags: ["夜景", "闪光", "Y2K", "半身"]
    };
  }

  if (/(summer|green|outdoor|sun|tree|夏|树荫|户外|草地)/i.test(text)) {
    return {
      title: "夏日树荫自然光写真",
      pose: "半身或中景，身体轻微前倾或侧身，手部自然互动，表情轻松看向镜头",
      scene: "室外树荫、街边或公园环境，背景有自然绿色",
      lighting: "自然阳光穿过树叶，脸部有柔和明暗层次",
      composition: "半身竖图，人物靠近画面中心，浅景深背景",
      camera: "手机或微单自然抓拍，清晰但不过度磨皮",
      color: "绿色偏浓，肤色暖亮，整体通透",
      outfit: "浅色夏季上衣，造型清爽",
      mood: "松弛、清透、生活化",
      tags: ["户外", "夏日", "自然光", "树荫"]
    };
  }

  if (/(cafe|coffee|室内|咖啡|暖光|window)/i.test(text)) {
    return {
      title: "咖啡店暖光生活写真",
      pose: "近景半身，坐姿或倚靠姿态，手部与桌面、杯子、窗边自然互动",
      scene: "咖啡店、窗边或室内生活场景",
      lighting: "窗边自然光混合室内暖光，阴影柔和",
      composition: "近景半身，人物与桌面或窗边环境形成层次",
      camera: "轻微胶片感，低锐化，生活化抓拍",
      color: "暖棕、奶白和低饱和背景色，肤色自然",
      outfit: "简洁日常穿搭，避免过强图案抢风格",
      mood: "安静、自然、轻微电影感",
      tags: ["咖啡店", "室内", "暖光", "生活感"]
    };
  }

  if (/(studio|ecommerce|product|棚|电商|白底|影棚)/i.test(text)) {
    return {
      title: "干净棚拍人像",
      pose: "正面或三分之二半身，肩颈打开，双手自然放松，姿态稳定",
      scene: "简洁影棚或浅色室内背景，画面干净",
      lighting: "大面积柔光，面部阴影轻，轮廓清楚",
      composition: "正面或三分之二半身，人物比例稳定",
      camera: "商业人像摄影质感，高解析但不过度修饰",
      color: "中性色、浅灰白背景，肤色准确",
      outfit: "干净利落的上衣，适合电商或形象照",
      mood: "专业、清爽、可信",
      tags: ["棚拍", "电商", "柔光", "干净背景"]
    };
  }

  if (/(ccd|film|胶片|复古|grain|vintage)/i.test(text)) {
    return {
      title: "胶片 CCD 复古写真",
      pose: "近景或半身随拍，身体角度自然，表情和手部动作带轻微抓拍感",
      scene: "日常室内外场景，保留真实环境细节",
      lighting: "自然光或小型闪光灯，允许轻微曝光不均",
      composition: "近景或半身随拍，画面有轻微随机感",
      camera: "CCD 或胶片机质感，轻微颗粒、锐化和色偏",
      color: "低饱和，暗部带绿或蓝，肤色偏暖",
      outfit: "复古或简洁日常穿搭",
      mood: "怀旧、随性、真实",
      tags: ["CCD", "胶片", "复古", "随拍"]
    };
  }

  return {
    title: "网页参考风格写真",
    pose: "保持参考图中头部朝向、手臂位置、身体角度、景别和人物占画面比例",
    scene: "参考图中的主要环境与空间关系",
    lighting: "延续参考图的主光方向、阴影强度和环境光比例",
    composition: "保持参考图的景别、人物位置和背景留白关系",
    camera: "真实摄影质感，清晰自然，不过度磨皮",
    color: "参考图的整体色温、饱和度和明暗对比",
    outfit: "与参考图氛围一致的简洁穿搭",
    mood: "自然、真实、适合个人写真",
    tags: ["网页参考", "人像", "风格迁移", "本地"]
  };
}
