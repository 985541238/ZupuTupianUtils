/** 与 server/src/ocr/layout-styles.ts 一致：只保留卷四横表。 */
export const OCR_LAYOUT_STYLES = [
  {
    id: 'table',
    label: '横表',
    hint: '每一世一块。下一世顶部是上一世的人名和儿子，儿子下面那一列是本人介绍。一共十六世。',
    example: '崔氏支谱卷四',
    enabled: true,
  },
] as const;

export type OcrLayoutStyleId = (typeof OCR_LAYOUT_STYLES)[number]['id'];

export function ocrLayoutLabel(id?: string | null) {
  void id;
  return '横表';
}
