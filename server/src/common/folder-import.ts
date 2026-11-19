import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** 图片处理与 OCR 共用的图片扩展名白名单。 */
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

/** 列出目录下的一级图片文件（按名称排序，中文按拼音/本地序），不递归。 */
export function listImageFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => isImageFile(f))
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 项目根目录下的一级子目录（跳过隐藏/系统目录），与图片处理建项目规则一致。 */
export function scanFirstLevelDirs(rootPath: string): string[] {
  return fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => path.join(rootPath, e.name));
}

export function dirHasImages(dir: string): boolean {
  try {
    return listImageFiles(dir).length > 0;
  } catch {
    return false;
  }
}

/** 图片内容指纹（sha256），同名卷合并时用来去重；读不到时退化为 size+文件名。 */
export function imageFingerprint(filePath: string, fallbackName = ''): string {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return `missing:${fallbackName.toLowerCase()}`;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    try {
      return `size:${fs.statSync(filePath).size}:${fallbackName.toLowerCase()}`;
    } catch {
      return `missing:${fallbackName.toLowerCase()}`;
    }
  }
}

/** 文件名安全化（去掉扩展名并替换非法字符），用于输出目录命名。 */
export function safeName(name: string): string {
  return path.basename(String(name || ''), path.extname(String(name || ''))).replace(/[<>:"/\\|?*]/g, '_') || 'unnamed';
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
