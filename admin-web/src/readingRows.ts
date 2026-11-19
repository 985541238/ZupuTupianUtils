import { OcrChar, OcrColumn } from './types';

/** 用户在图上划出的一行，坐标是相对整页的 0~1，换页后按同样比例套到下一张图 */
export type ReadingRow = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type RowChar = { col: number; idx: number; ch: OcrChar };

type Store = { template: ReadingRow[]; pages: Record<string, ReadingRow[]> };

const empty = (): Store => ({ template: [], pages: {} });

function key(taskId: string) {
  return `ocr-reading-rows:${taskId}`;
}

export function loadReading(taskId: string): Store {
  try {
    const raw = localStorage.getItem(key(taskId));
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Store;
    return {
      template: Array.isArray(parsed?.template) ? parsed.template.filter(validRow) : [],
      pages: parsed?.pages && typeof parsed.pages === 'object' ? parsed.pages : {},
    };
  } catch {
    return empty();
  }
}

export function saveReading(taskId: string, store: Store) {
  localStorage.setItem(key(taskId), JSON.stringify(store));
}

export function rowsForPage(store: Store, pageId: string): { rows: ReadingRow[]; pageOnly: boolean } {
  const own = store.pages[pageId];
  if (Array.isArray(own)) return { rows: own.filter(validRow), pageOnly: true };
  return { rows: store.template, pageOnly: false };
}

/** 写入当前页。pageOnly 时只改这一页，否则作为本卷后面各页的框。 */
export function writeRows(taskId: string, pageId: string, rows: ReadingRow[], pageOnly: boolean) {
  const store = loadReading(taskId);
  if (pageOnly) store.pages[pageId] = rows;
  else {
    store.template = rows;
    delete store.pages[pageId];
  }
  saveReading(taskId, store);
}

function validRow(r: ReadingRow) {
  return !!r && typeof r.id === 'string' && r.w > 0.002 && r.h > 0.002;
}

function inside(ch: OcrChar, row: ReadingRow, pageW: number, pageH: number) {
  const cx = (ch.b[0] + ch.b[2]) / 2;
  const cy = (ch.b[1] + ch.b[3]) / 2;
  const x1 = row.x * pageW;
  const y1 = row.y * pageH;
  const x2 = (row.x + row.w) * pageW;
  const y2 = (row.y + row.h) * pageH;
  return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
}

/**
 * 一个框里的字：先按竖列从右往左，列内从上往下。
 * 返回的每一组是一列，组的顺序就是从右往左。
 */
export function readRowColumns(columns: OcrColumn[], row: ReadingRow, pageW: number, pageH: number): RowChar[][] {
  const hits: Array<RowChar & { cx: number; cy: number; w: number }> = [];
  columns.forEach((c, col) => {
    c.chars.forEach((ch, idx) => {
      if (!inside(ch, row, pageW, pageH)) return;
      hits.push({
        col,
        idx,
        ch,
        cx: (ch.b[0] + ch.b[2]) / 2,
        cy: (ch.b[1] + ch.b[3]) / 2,
        w: Math.max(1, ch.b[2] - ch.b[0]),
      });
    });
  });
  hits.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  const widths = hits.map((h) => h.w).sort((a, b) => a - b);
  const med = widths[Math.floor(widths.length / 2)] || 40;
  const groups: Array<typeof hits> = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (!last || !prev || h.cx - prev.cx > med * 0.7) groups.push([h]);
    else last.push(h);
  }
  return groups
    .map((g) => g.slice().sort((a, b) => a.cy - b.cy).map(({ col, idx, ch }) => ({ col, idx, ch })))
    .reverse();
}

export function charsOutsideRows(columns: OcrColumn[], rows: ReadingRow[], pageW: number, pageH: number): RowChar[] {
  const out: Array<RowChar & { cy: number; cx: number }> = [];
  columns.forEach((c, col) => {
    c.chars.forEach((ch, idx) => {
      if (rows.some((row) => inside(ch, row, pageW, pageH))) return;
      out.push({ col, idx, ch, cx: (ch.b[0] + ch.b[2]) / 2, cy: (ch.b[1] + ch.b[3]) / 2 });
    });
  });
  out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return out.map(({ col, idx, ch }) => ({ col, idx, ch }));
}
