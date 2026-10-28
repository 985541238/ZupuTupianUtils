import { OcrResult, OcrUncertain } from '../ai/aliyun.service';

export function readOcr(json: string | null | undefined): OcrResult {
  if (!json) return { columns: [], uncertain: [] };
  try {
    const d = JSON.parse(json);
    return {
      columns: Array.isArray(d.columns) ? d.columns : [],
      uncertain: Array.isArray(d.uncertain) ? d.uncertain : [],
    };
  } catch {
    return { columns: [], uncertain: [] };
  }
}

export function pageText(ocr: OcrResult): string {
  return ocr.columns.map((c) => c.text).join('\n');
}

/**
 * 人改了某些列的文字：改过的列里，疑似错字标记全部视为已处理并清掉；
 * 没改的列保留原标记。人自己打的 □ 视为有意保留，不再标出。
 */
export function applyColumnEdits(ocr: OcrResult, texts: string[]): OcrResult {
  const columns = texts.map((t, i) => ({
    text: String(t ?? '').replace(/\s+/g, ''),
    box: ocr.columns[i]?.box ?? null,
  }));
  const uncertain: OcrUncertain[] = ocr.uncertain.filter((u) => {
    const before = ocr.columns[u.col]?.text;
    const after = columns[u.col]?.text;
    return before != null && after != null && before === after;
  });
  const kept = columns.filter((c) => c.text.length > 0);
  // 删掉空列后，列序号要重排
  const remap = new Map<number, number>();
  let j = 0;
  columns.forEach((c, i) => {
    if (c.text.length > 0) remap.set(i, j++);
  });
  const remapped = uncertain
    .filter((u) => remap.has(u.col))
    .map((u) => ({ ...u, col: remap.get(u.col)! }));
  return { columns: kept, uncertain: remapped };
}
