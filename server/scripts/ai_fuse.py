#!/usr/bin/env python3
"""
大模型结果「保真合成」：最终图里的每一笔都取自原图，大模型结果只用来判断哪里是字、哪里是污渍。

为什么需要：图生图大模型会「重画」整页——改字、挪位置、甚至丢掉半页。族谱不允许改字，
所以不直接用模型出的图，而是：
  1. 原图去底色后取出所有深色（字 + 污渍）；
  2. 把模型结果对齐到原图上，模型结果里是字的地方（略放宽）才保留原图的深色，其余一律变白；
  3. 模型结果与原图版面对不上（改了版式、丢了内容）时拒绝，不输出。

用法：python ai_fuse.py --orig 原图 --ai 模型结果 --out 输出.png
最后一行输出 JSON：{"ok":true,...} 或 {"ok":false,"error":"mismatch",...}
"""
from __future__ import annotations

import argparse
import json
import sys

import cv2
import numpy as np


def read_gray(path: str) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("无法读取图片：" + path)
    if img.dtype != np.uint8:
        img = cv2.convertScaleAbs(img, alpha=255.0 / max(1, int(img.max())))
    if img.ndim == 3 and img.shape[2] == 4:
        a = img[:, :, 3:4].astype(np.float32) / 255.0
        img = (img[:, :, :3].astype(np.float32) * a + 255.0 * (1 - a)).astype(np.uint8)
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


def normalize_bg(g: np.ndarray) -> np.ndarray:
    """去纸张底色：用大核闭运算估计背景（字被抹掉，大片污渍/黄斑留在背景里），再相除拉平"""
    h, w = g.shape
    s = min(1.0, 1000.0 / max(h, w))
    small = cv2.resize(g, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA) if s < 1 else g
    k = max(15, int(min(small.shape) * 0.035)) | 1
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    bg = cv2.GaussianBlur(bg, (0, 0), k / 4.0)
    if s < 1:
        bg = cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)
    n = g.astype(np.float32) / np.maximum(bg.astype(np.float32), 1.0) * 255.0
    return np.clip(n, 0, 255).astype(np.uint8)


def otsu(g: np.ndarray, lo: int, hi: int) -> int:
    t, _ = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return int(min(hi, max(lo, t)))


def disk(r: int) -> np.ndarray:
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def ratio(a: np.ndarray, b: np.ndarray) -> float:
    s = int(np.count_nonzero(b))
    return float(np.count_nonzero(a & b)) / s if s else 0.0


def glyph_mask(ink: np.ndarray) -> np.ndarray:
    """字大小的连通块（排除大片污渍和噪点），用来检查模型有没有丢内容"""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
    short = min(ink.shape)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a >= 6 and max(w, h) <= short * 0.08 and a <= (short * 0.08) ** 2 * 0.7:
            keep[i] = True
    return keep[lab]


def align(o_ink_s: np.ndarray, a_ink_s: np.ndarray) -> np.ndarray:
    """ECC 仿射对齐（小图上），失败或变换离谱时返回单位阵"""
    eye = np.eye(2, 3, dtype=np.float32)
    t = cv2.GaussianBlur(o_ink_s.astype(np.float32), (0, 0), 2.0)
    m = cv2.GaussianBlur(a_ink_s.astype(np.float32), (0, 0), 2.0)
    warp = eye.copy()
    try:
        _, warp = cv2.findTransformECC(
            t, m, warp, cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5), None, 5,
        )
    except cv2.error:
        return eye
    sx = float(np.hypot(warp[0, 0], warp[1, 0]))
    sy = float(np.hypot(warp[0, 1], warp[1, 1]))
    h, w = o_ink_s.shape
    if not (0.85 < sx < 1.15 and 0.85 < sy < 1.15) or abs(warp[0, 2]) > w * 0.08 or abs(warp[1, 2]) > h * 0.08:
        return eye
    return warp


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--orig", required=True)
    p.add_argument("--ai", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--min-recall", type=float, default=0.7)
    p.add_argument("--max-dropped", type=int, default=2)
    a = p.parse_args()

    o = read_gray(a.orig)
    h, w = o.shape
    ai = cv2.resize(read_gray(a.ai), (w, h), interpolation=cv2.INTER_AREA)

    n = normalize_bg(o)
    t_o = otsu(n, 120, 225)
    # 原图深色取得宽一些（淡笔画也要），污渍靠模型结果来排除
    o_ink = n < min(235, t_o + 12)
    a_ink = ai < otsu(ai, 90, 200)

    # ---- 小图上对齐 + 检查版面是否一致
    s = min(1.0, 1200.0 / max(h, w))
    sw, sh = max(1, int(w * s)), max(1, int(h * s))
    o_s = cv2.resize(o_ink.astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST).astype(bool)
    a_s = cv2.resize(a_ink.astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST).astype(bool)
    warp = align(o_s, a_s)
    flags = cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP
    a_s2 = cv2.warpAffine(a_s.astype(np.uint8), warp, (sw, sh), flags=flags, borderValue=0).astype(bool)

    tol = disk(max(2, round(min(sh, sw) * 0.004)))
    recall = ratio(cv2.dilate(o_s.astype(np.uint8), tol).astype(bool), a_s2)  # 模型画的字，原图那里有没有
    g = glyph_mask(o_s)
    a_near = cv2.dilate(a_s2.astype(np.uint8), disk(max(3, round(min(sh, sw) * 0.01)))).astype(bool)
    coverage = ratio(a_near, g)  # 原图里像字的东西，模型保留了多少

    # 分块检查：原图字很密、模型结果却几乎空白 → 模型丢了内容
    dropped = 0
    gy, gx = 4, 4
    for i in range(gy):
        for j in range(gx):
            ys, ye = sh * i // gy, sh * (i + 1) // gy
            xs, xe = sw * j // gx, sw * (j + 1) // gx
            gc = int(np.count_nonzero(g[ys:ye, xs:xe]))
            if gc > (ye - ys) * (xe - xs) * 0.02 and np.count_nonzero(a_near[ys:ye, xs:xe] & g[ys:ye, xs:xe]) < gc * 0.15:
                dropped += 1

    meta = {"recall": round(recall, 3), "coverage": round(coverage, 3), "dropped": dropped,
            "shift": [round(float(warp[0, 2] / s), 1), round(float(warp[1, 2] / s), 1)], "width": w, "height": h}
    if int(np.count_nonzero(a_s2)) < sw * sh * 0.002 or recall < a.min_recall or dropped > a.max_dropped:
        print(json.dumps({"ok": False, "error": "mismatch", **meta}))
        return 2

    # ---- 原尺寸合成
    full = warp.copy()
    full[:, 2] /= s
    a_full = cv2.warpAffine(a_ink.astype(np.uint8), full, (w, h), flags=flags, borderValue=0)
    gate = cv2.dilate(a_full, disk(max(3, round(min(h, w) * 0.005)))).astype(bool)
    keep = o_ink & gate

    # 去掉孤立小点
    cnt, lab, stats, _ = cv2.connectedComponentsWithStats(keep.astype(np.uint8), 8)
    min_area = max(4, int(min(h, w) * min(h, w) * 2e-6))
    small = np.zeros(cnt, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < min_area
    keep &= ~small[lab]

    # 笔画保留原图的浓淡过渡（边缘不发毛），其余纯白
    soft = cv2.dilate(keep.astype(np.uint8), disk(1)).astype(bool)
    lo = float(np.percentile(n[keep], 5)) if np.any(keep) else 0.0
    hi = float(t_o + 12)
    v = np.clip((n.astype(np.float32) - lo) / max(1.0, hi - lo), 0, 1) ** 1.4 * 255.0
    out = np.full((h, w), 255, np.uint8)
    out[soft] = v[soft].astype(np.uint8)
    out[keep] = np.minimum(out[keep], (v[keep] * 0.6).astype(np.uint8))

    ok, buf = cv2.imencode(".png", out)
    if not ok:
        raise ValueError("写出失败")
    buf.tofile(a.out)
    print(json.dumps({"ok": True, **meta}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
