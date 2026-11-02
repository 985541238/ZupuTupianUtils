/**
 * 竖排古籍的阅读顺序。
 *
 * 整页都是竖排时，顺序就是「从右到左」；但很多页面是分段的（世系图、表格、上下几段各自竖排），
 * 这时全页一刀切「从右到左」会把上下两段的列穿插在一起。这里用递归 XY-cut：
 *   1) 有一条横向空白带贯穿整个区域 → 上、下分段，先上后下；
 *   2) 否则有一条纵向空白带 → 左、右分块，先右后左；
 *   3) 都切不开 → 这一块内部就是普通竖排：从右到左，同一横向位置的从上到下。
 */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** 在一组区间的并集里，找出宽度 >= minGap 的空隙（返回空隙的 [起, 止]，按起点升序） */
function gaps(items: Box[], lo: 'x1' | 'y1', hi: 'x2' | 'y2', minGap: number): [number, number][] {
  const iv = items.map((b) => [b[lo], b[hi]] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let end = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    if (iv[i][0] - end >= minGap) out.push([end, iv[i][0]]);
    end = Math.max(end, iv[i][1]);
  }
  return out;
}

export function readingOrder<T extends Box>(items: T[], pageW: number, pageH: number, depth = 0): T[] {
  if (items.length <= 1) return [...items];
  const medW = median(items.map((b) => b.x2 - b.x1)) || 1;

  if (depth < 8) {
    // 1) 横向分段：空白带至少一个字宽的 1.5 倍、且不小于页高的 2.5%
    const hg = gaps(items, 'y1', 'y2', Math.max(medW * 1.5, pageH * 0.025));
    if (hg.length) {
      // 取最宽的一条空白带切；两边各自递归，先上后下
      const [a, b] = hg.reduce((m, g) => (g[1] - g[0] > m[1] - m[0] ? g : m));
      const mid = (a + b) / 2;
      const top = items.filter((x) => (x.y1 + x.y2) / 2 < mid);
      const bottom = items.filter((x) => (x.y1 + x.y2) / 2 >= mid);
      if (top.length && bottom.length) return [...readingOrder(top, pageW, pageH, depth + 1), ...readingOrder(bottom, pageW, pageH, depth + 1)];
    }
    // 2) 纵向分块：空白带至少 3 个字宽（比列间距宽得多），先右后左
    const vg = gaps(items, 'x1', 'x2', Math.max(medW * 3, pageW * 0.04));
    if (vg.length) {
      const [a, b] = vg.reduce((m, g) => (g[1] - g[0] > m[1] - m[0] ? g : m));
      const mid = (a + b) / 2;
      const right = items.filter((x) => (x.x1 + x.x2) / 2 >= mid);
      const left = items.filter((x) => (x.x1 + x.x2) / 2 < mid);
      if (right.length && left.length) return [...readingOrder(right, pageW, pageH, depth + 1), ...readingOrder(left, pageW, pageH, depth + 1)];
    }
  }
  // 3) 一块之内：从右到左；同一横向位置的从上到下
  return [...items].sort((a, b) => {
    const ca = (a.x1 + a.x2) / 2;
    const cb = (b.x1 + b.x2) / 2;
    const tol = Math.min(a.x2 - a.x1, b.x2 - b.x1) * 0.5;
    return Math.abs(ca - cb) <= tol ? a.y1 - b.y1 : cb - ca;
  });
}
