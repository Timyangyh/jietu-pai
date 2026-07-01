export interface PreparedImage {
  dataUrl: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
}

export async function prepareImageFile(file: File, maxSide = 1600): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择 PNG、JPG 或 WebP 图片");
  }
  const rawDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(rawDataUrl);
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));

  if (scale >= 1 && file.size <= 3 * 1024 * 1024) {
    return {
      dataUrl: rawDataUrl,
      fileName: file.name,
      mimeType: file.type,
      width: image.naturalWidth,
      height: image.naturalHeight
    };
  }

  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理这张图片");
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
  const suffix = file.type === "image/png" ? ".png" : ".jpg";
  return {
    dataUrl,
    fileName: replaceExtension(file.name, suffix),
    mimeType: file.type === "image/png" ? "image/png" : "image/jpeg",
    width,
    height
  };
}

export async function cropDataUrl(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  pixelRatio: number
): Promise<string> {
  const image = await loadImage(dataUrl);
  const sx = Math.max(0, Math.round(rect.x * pixelRatio));
  const sy = Math.max(0, Math.round(rect.y * pixelRatio));
  const sw = Math.max(1, Math.round(rect.width * pixelRatio));
  const sh = Math.max(1, Math.round(rect.height * pixelRatio));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法裁切截图");
  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法预览"));
    image.src = dataUrl;
  });
}

function replaceExtension(fileName: string, nextExtension: string): string {
  return fileName.replace(/\.[^.]+$/, "") + nextExtension;
}
