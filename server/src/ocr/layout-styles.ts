/**
 * 现在只处理崔氏支谱卷四这一种横表。
 * 一世是一块；下一世顶部写上一世的人名和他的儿子，每个儿子下面那一列是这个儿子的介绍。一共十六世。
 */
export type LayoutStyleId = 'table';

export interface LayoutStyleDef {
  id: LayoutStyleId;
  label: string;
  hint: string;
  example: string;
  enabled: boolean;
}

export const LAYOUT_STYLES: LayoutStyleDef[] = [
  {
    id: 'table',
    label: '横表',
    hint: '每一世一块。下一世顶部是上一世的人名和儿子，儿子下面那一列是本人介绍。从右往左，一共十六世。',
    example: '崔氏支谱卷四',
    enabled: true,
  },
];

export function layoutStyleDef(id?: string | null): LayoutStyleDef | null {
  void id;
  return LAYOUT_STYLES[0];
}

/** 不再让用户选版式，新建项目一律按卷四横表。 */
export function requireLayoutStyle(raw?: string | null): LayoutStyleId {
  void raw;
  return 'table';
}

export function normalizeLayoutStyle(raw?: string | null): LayoutStyleId {
  void raw;
  return 'table';
}
