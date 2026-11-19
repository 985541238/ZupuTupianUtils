import { OcrChar, OcrColumn } from './types';

/**
 * 卷四横表：一整列从上往下读完，再读左边一列。
 * 不把同一横条上的一世、清獻、天德、三世拼成一行。
 */
export function orderColumnsLeftToRight(cols: OcrColumn[]): OcrColumn[] {
  const src = (cols || []).filter((c) => c?.chars?.length);
  if (!src.length) return [];
  type Ch = OcrChar & { cx: number };
  const chars: Ch[] = [];
  for (const c of src) {
    for (const ch of c.chars) chars.push({ ...ch, cx: (ch.b[0] + ch.b[2]) / 2 });
  }
  chars.sort((a, b) => a.cx - b.cx);
  const groups: Ch[][] = [];
  for (const ch of chars) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (!g || !last || ch.cx - last.cx > 42) groups.push([ch]);
    else g.push(ch);
  }
  const columns: OcrColumn[] = groups.map((g) => {
    const sorted = [...g].sort((a, b) => a.b[1] - b.b[1]);
    return { ...src[0], id: 0, box: unionBox(sorted), chars: sorted.map(({ cx: _cx, ...ch }) => ch) };
  });
  columns.sort((a, b) => b.box[0] - a.box[0] || a.box[1] - b.box[1]);
  return columns.map((c, i) => ({ ...c, id: i }));
}

function unionBox(chars: OcrChar[]): [number, number, number, number] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const ch of chars) {
    x1 = Math.min(x1, ch.b[0]);
    y1 = Math.min(y1, ch.b[1]);
    x2 = Math.max(x2, ch.b[2]);
    y2 = Math.max(y2, ch.b[3]);
  }
  return [x1, y1, x2, y2];
}
