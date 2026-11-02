// 图片种类的判定：前后端共用（Worker 认附件、任务收尾发图、对话里渲染缩略图都用它）。

/** 能当图片处理的扩展名 → MIME。 */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 按扩展名判断是不是图片（不读文件）。 */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return path.slice(dot).toLowerCase() in IMAGE_TYPES;
}
