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


def stroke_width(ink: np.ndarray) -> float:
    """笔画宽度（像素）：距离变换在笔画中轴上的值 ×2 的中位数"""
    m = ink.astype(np.uint8)
    if not m.any():
        return 4.0
    dt = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    ridge = (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8))) & (dt > 0.5)
    v = dt[ridge]
    return float(np.clip(np.median(v) * 2 if v.size else 4.0, 2.0, 40.0))


def local_refine(o_ink: np.ndarray, a_ink: np.ndarray, grid: int = 8) -> np.ndarray:
    """分块相位相关求局部位移（只用字多的块），中值平滑后插值成位移场，把模型笔画贴到原图笔画上"""
    h, w = o_ink.shape
    s = min(1.0, 1600.0 / max(h, w))
    sw, sh = max(1, int(w * s)), max(1, int(h * s))
    o = cv2.GaussianBlur(cv2.resize(o_ink.astype(np.float32), (sw, sh), interpolation=cv2.INTER_AREA), (0, 0), 1.5)
    a = cv2.GaussianBlur(cv2.resize(a_ink.astype(np.float32), (sw, sh), interpolation=cv2.INTER_AREA), (0, 0), 1.5)
    dx = np.zeros((grid, grid), np.float32)
    dy = np.zeros((grid, grid), np.float32)
    ok = np.zeros((grid, grid), bool)
    win = np.float32(cv2.createHanningWindow((sw // grid, sh // grid), cv2.CV_32F))
    for i in range(grid):
        for j in range(grid):
            ys, xs = sh * i // grid, sw * j // grid
            to = o[ys : ys + sh // grid, xs : xs + sw // grid]
            ta = a[ys : ys + sh // grid, xs : xs + sw // grid]
            if to.shape != win.shape or ta.mean() < 0.02:
                continue
            (sx, sy), resp = cv2.phaseCorrelate(ta, to, win)
            if resp > 0.08 and abs(sx) < sw / grid * 0.15 and abs(sy) < sh / grid * 0.15:
                dx[i, j], dy[i, j], ok[i, j] = sx, sy, True
    if not ok.any():
        return a_ink
    # 没有可靠估计的块用整体中位数补，再做中值平滑去掉个别离群
    dx[~ok] = np.median(dx[ok])
    dy[~ok] = np.median(dy[ok])
    dx = cv2.medianBlur(dx, 3)
    dy = cv2.medianBlur(dy, 3)
    fx = cv2.resize(dx / s, (w, h), interpolation=cv2.INTER_CUBIC)
    fy = cv2.resize(dy / s, (w, h), interpolation=cv2.INTER_CUBIC)
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = cv2.remap(a_ink.astype(np.uint8), gx - fx, gy - fy, cv2.INTER_NEAREST, borderValue=0)
    return out


def content_box(ink: np.ndarray) -> tuple[float, float, float, float] | None:
    """版面范围：按行/列的墨量取 1%~99% 分位，忽略零星噪点"""
    ys, xs = np.nonzero(ink)
    if xs.size < 50:
        return None
    return (float(np.percentile(xs, 1)), float(np.percentile(ys, 1)), float(np.percentile(xs, 99)), float(np.percentile(ys, 99)))


def ecc(t: np.ndarray, m: np.ndarray, init: np.ndarray) -> np.ndarray | None:
    warp = init.astype(np.float32).copy()
    try:
        _, warp = cv2.findTransformECC(
            t, m, warp, cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5), None, 5,
        )
    except cv2.error:
        return None
    # 与初值相比变化不能太离谱
    s0x, s0y = float(np.hypot(*init[:, 0])), float(np.hypot(*init[:, 1]))
    sx, sy = float(np.hypot(warp[0, 0], warp[1, 0])), float(np.hypot(warp[0, 1], warp[1, 1]))
    h, w = t.shape
    if not (0.85 < sx / s0x < 1.15 and 0.85 < sy / s0y < 1.15):
        return None
    if abs(warp[0, 2] - init[0, 2]) > w * 0.1 or abs(warp[1, 2] - init[1, 2]) > h * 0.1:
        return None
    return warp


def align(o_ink_s: np.ndarray, a_ink_s: np.ndarray) -> list[np.ndarray]:
    """候选对齐：①直接拉伸到原图尺寸 ②按版面范围对齐（模型加了白边、裁了边、缩放了画面时）。各自再做 ECC 细调。"""
    eye = np.eye(2, 3, dtype=np.float32)
    t = cv2.GaussianBlur(o_ink_s.astype(np.float32), (0, 0), 2.0)
    m = cv2.GaussianBlur(a_ink_s.astype(np.float32), (0, 0), 2.0)
    inits = [eye]
    bo, ba = content_box(o_ink_s), content_box(a_ink_s)
    if bo and ba and bo[2] > bo[0] and bo[3] > bo[1]:
        sx = (ba[2] - ba[0]) / (bo[2] - bo[0])
        sy = (ba[3] - ba[1]) / (bo[3] - bo[1])
        if 0.4 < sx < 2.5 and 0.4 < sy < 2.5:
            inits.append(np.float32([[sx, 0, ba[0] - sx * bo[0]], [0, sy, ba[1] - sy * bo[1]]]))
    out = []
    for init in inits:
        out.append(init)
        r = ecc(t, m, init)
        if r is not None:
            out.append(r)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--orig", required=True)
    p.add_argument("--ai", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()

    o = read_gray(a.orig)
    h, w = o.shape
    ai = cv2.resize(read_gray(a.ai), (w, h), interpolation=cv2.INTER_AREA)
    if float(np.median(ai)) < 110:  # 模型出成了黑底白字：反相后再用
        ai = 255 - ai

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
    flags = cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP
    tol = disk(max(2, round(min(sh, sw) * 0.004)))
    o_dil = cv2.dilate(o_s.astype(np.uint8), tol).astype(bool)
    best = None
    for cand in align(o_s, a_s):
        a_c = cv2.warpAffine(a_s.astype(np.uint8), cand, (sw, sh), flags=flags, borderValue=0).astype(bool)
        a_c = local_refine(o_s, a_c.astype(np.uint8)).astype(bool)
        r = ratio(o_dil, a_c)  # 模型画的字，原图那里有没有
        if best is None or r > best[0]:
            best = (r, cand, a_c)
    recall, warp, a_s2 = best
    g = glyph_mask(o_s)
    a_near = cv2.dilate(a_s2.astype(np.uint8), disk(max(3, round(min(sh, sw) * 0.01)))).astype(bool)
    coverage = ratio(a_near, g)  # 原图里像字的东西，模型保留了多少

    # 分块评估：字密的块里，模型对不上（画错位置或没画）→ 这一块不用模型结果，保持原图
    gy, gx = 6, 6
    bad = np.zeros((gy, gx), bool)
    text_tiles = 0
    stats_dbg = []
    for i in range(gy):
        for j in range(gx):
            ys, ye = sh * i // gy, sh * (i + 1) // gy
            xs, xe = sw * j // gx, sw * (j + 1) // gx
            gt = g[ys:ye, xs:xe]
            gc = int(np.count_nonzero(gt))
            if gc <= (ye - ys) * (xe - xs) * 0.015:
                continue
            text_tiles += 1
            at = a_s2[ys:ye, xs:xe]
            cov = np.count_nonzero(a_near[ys:ye, xs:xe] & gt) / gc
            rec = ratio(o_dil[ys:ye, xs:xe], at) if np.count_nonzero(at) > 20 else 0.0
            a_cnt = int(np.count_nonzero(at))
            dens = gc / float((ye - ys) * (xe - xs))
            # ①模型在这里画了东西，但和原图对不上 → 画错了
            misdrawn = a_cnt > gc * 0.15 and rec < 0.6
            # ②原图这里字很密（像正文），模型几乎没画 → 丢了内容。
            #   零散污点密度低，模型去掉它们是对的，不算丢内容
            dropped = dens > 0.05 and cov < 0.2
            if misdrawn or dropped:
                bad[i, j] = True
            stats_dbg.append((i, j, round(dens, 3), round(cov, 2), round(rec, 2), a_cnt))
    nbad = int(bad.sum())

    meta = {"recall": round(recall, 3), "coverage": round(coverage, 3), "bad_tiles": nbad, "text_tiles": text_tiles,
            "shift": [round(float(warp[0, 2] / s), 1), round(float(warp[1, 2] / s), 1)], "width": w, "height": h}
    if int(np.count_nonzero(a_s2)) < sw * sh * 0.002 or text_tiles == 0 or nbad > text_tiles * 0.4 or recall < 0.7:
        print(json.dumps({"ok": False, "error": "mismatch", **meta}))
        return 2

    # ---- 原尺寸合成
    full = warp.copy()
    full[:, 2] /= s
    a_full = cv2.warpAffine(a_ink.astype(np.uint8), full, (w, h), flags=flags, borderValue=0)
    # 局部再对齐：大模型重画时各处会有几个像素的漂移，分块求位移再平滑成整幅位移场
    a_full = local_refine(o_ink, a_full)
    # 收紧容差：只在模型笔画外扩约 0.4 个笔宽的范围内保留原图深色。
    # 容差过宽会把紧挨笔画的污渍一起留下，字就糊成黑块。
    sw_px = stroke_width(a_full)
    gate = cv2.dilate(a_full, disk(max(1, round(sw_px * 0.25)))).astype(bool)
    keep = o_ink & gate
    if nbad:
        # 对不上的块：保持原图（只去掉明显的大片污渍），不冒险用模型结果
        orig_keep = glyph_mask(o_ink)
        for i in range(gy):
            for j in range(gx):
                if bad[i, j]:
                    ys, ye = h * i // gy, h * (i + 1) // gy
                    xs, xe = w * j // gx, w * (j + 1) // gx
                    keep[ys:ye, xs:xe] = orig_keep[ys:ye, xs:xe]

    # 去掉孤立小点
    cnt, lab, stats, _ = cv2.connectedComponentsWithStats(keep.astype(np.uint8), 8)
    min_area = max(4, int(min(h, w) * min(h, w) * 2e-6))
    small = np.zeros(cnt, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < min_area
    keep &= ~small[lab]

    # 白底黑字：笔画纯黑，只在笔画边缘 1 像素按原图浓淡做过渡（不发毛、不锯齿），其余纯白
    soft = cv2.dilate(keep.astype(np.uint8), disk(1)).astype(bool) & ~keep
    hi = float(t_o + 12)
    lo = hi * 0.5
    edge = np.clip((n.astype(np.float32) - lo) / max(1.0, hi - lo), 0, 1) * 255.0
    out = np.full((h, w), 255, np.uint8)
    out[soft] = edge[soft].astype(np.uint8)
    out[keep] = 0

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
