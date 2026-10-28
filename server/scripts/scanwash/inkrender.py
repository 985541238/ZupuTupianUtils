"""墨迹提取与渲染（新核心）。

旧流程的两个根因：
1. composite() 只拿掩膜算分位数，成品直接用整页灰度渲染。mask.py 里所有剔污渍、
   剔透字的逻辑都没落到成品上，暗一点的污渍原样留下。
2. 色调映射把“比墨心浅”的像素一刀切成白，再把离墨心 9px 以外的灰全部抹白，
   细横画、淡墨字被吃掉，看起来就是“不清晰、断笔”。

新流程：
- 亮度取各通道最大值与灰度的混合：黄斑、茶渍、霉斑在 R 通道里几乎和纸一样亮，
  墨在所有通道都暗，这一步就把彩色污渍压掉大半。
- 平场：闭运算估纸，核按估计笔画宽度定，大于笔画、远小于污渍。
- 双阈值（滞后）掩膜：强阈值做种子，弱阈值只在与种子相连时保留。
  细笔画能整笔连上，孤立的淡污渍、透字不会被带出来。
- 连通域筛选：去小噪点、去贴边黑框/黑边、去整体偏淡的污渍块。
- 渲染严格受掩膜约束：掩膜外一律白纸；掩膜内按墨色深浅做连续映射，保留抗锯齿边。
- 小图先放大再处理，输出更平滑。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class InkParams:
    # 0~1：越大越敏感（留更多淡墨），越小越干净
    sensitivity: float = 0.5
    # 0~1：去噪/去渍力度（最小连通域、淡块剔除）
    denoise: float = 0.5
    # 0~1：彩色污渍抑制（通道最大值混合比例）
    stain: float = 0.5
    # 0~1：边缘锐度（墨色映射陡峭程度）
    sharpen: float = 0.5
    # 处理时最短边小于该值则放大
    min_short_side: int = 1800


@dataclass
class InkResult:
    image: np.ndarray  # uint8 成品
    mask: np.ndarray  # bool 墨迹掩膜（成品尺寸）
    darkness: np.ndarray  # float32 0~1 平场后墨色深度
    scale: float
    stroke_width: float
    t_high: float
    t_low: float


def luminance(bgr: np.ndarray, stain: float) -> np.ndarray:
    """彩色污渍抑制后的亮度（float32 0~255）。"""
    f = bgr.astype(np.float32)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # 黄/褐斑：B 低、R 高；墨：三通道都低。取 max(G,R) 偏 R，蓝通道不参与。
    chan = np.maximum(f[:, :, 1] * 0.85 + f[:, :, 2] * 0.15, f[:, :, 2])
    w = float(np.clip(stain, 0.0, 1.0))
    return gray * (1.0 - w) + chan * w


def estimate_stroke_width(lum: np.ndarray) -> float:
    """Otsu 粗分墨迹，用距离场中位数估笔画宽度（像素）。"""
    u8 = np.clip(lum, 0, 255).astype(np.uint8)
    blur = cv2.GaussianBlur(u8, (0, 0), 1.0)
    _, ink = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    # 只看骨架附近的局部最大值
    dil = cv2.dilate(dist, np.ones((3, 3), np.uint8))
    ridge = (dist > 0.9) & (dist >= dil - 1e-3)
    vals = dist[ridge]
    if vals.size < 50:
        return 3.0
    return float(np.clip(2.0 * np.median(vals), 1.5, 40.0))


def flat_field(lum: np.ndarray, stroke_w: float) -> np.ndarray:
    """返回墨色深度 0~1（0=纸，越大越黑）。"""
    h, w = lum.shape
    k = int(np.clip(stroke_w * 7.0, 15, max(15, min(h, w) // 6)))
    k |= 1
    # 缩小图上估纸，快且平滑
    scale = min(1.0, 1400.0 / max(h, w))
    small = cv2.resize(lum, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else lum
    ks = max(3, int(k * scale) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks))
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    bg = cv2.medianBlur(np.clip(bg, 0, 255).astype(np.uint8), min(ks, 31) | 1).astype(np.float32)
    bg = cv2.GaussianBlur(bg, (0, 0), max(ks / 4.0, 1.0))
    if scale < 1:
        bg = cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)
    # 闭运算估出的背景不应比原图暗
    bg = np.maximum(bg, lum)
    bg = np.maximum(bg, 30.0)
    d = 1.0 - lum / bg
    return np.clip(d, 0.0, 1.0).astype(np.float32)


def _otsu01(values: np.ndarray) -> float:
    if values.size < 100:
        return 0.3
    u8 = np.clip(values * 255.0, 0, 255).astype(np.uint8).reshape(-1, 1)
    t, _ = cv2.threshold(u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return float(t) / 255.0


def hysteresis_mask(d: np.ndarray, p: InkParams) -> tuple[np.ndarray, float, float]:
    cand = d[d > 0.06]
    t = _otsu01(cand)
    sens = float(np.clip(p.sensitivity, 0.0, 1.0))
    # 敏感度 0.5 → 强阈值 = Otsu；越敏感越低
    t_high = float(np.clip(t * (1.35 - 0.7 * sens), 0.10, 0.85))
    t_low = float(np.clip(t_high * (0.62 - 0.22 * sens), 0.05, t_high - 0.02))
    strong = (d >= t_high).astype(np.uint8)
    weak = (d >= t_low).astype(np.uint8)
    n, labels = cv2.connectedComponents(weak, connectivity=8)
    has_seed = np.zeros(n, dtype=bool)
    has_seed[np.unique(labels[strong > 0])] = True
    has_seed[0] = False
    mask = has_seed[labels]
    return mask, t_high, t_low


def filter_components(mask: np.ndarray, d: np.ndarray, stroke_w: float, t_high: float, p: InkParams) -> np.ndarray:
    h, w = mask.shape
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask
    den = float(np.clip(p.denoise, 0.0, 1.0))
    area = stats[:, cv2.CC_STAT_AREA].astype(np.float64)
    # 每个连通域的平均/最大墨色
    flat = labels.ravel()
    dsum = np.bincount(flat, weights=d.ravel(), minlength=n)
    dmean = dsum / np.maximum(area, 1)
    dmax = np.zeros(n, np.float32)
    np.maximum.at(dmax, flat, d.ravel())

    keep = np.ones(n, dtype=bool)
    keep[0] = False
    # 典型字墨深
    big = area >= max(4.0, stroke_w * stroke_w)
    big[0] = False
    ref = float(np.median(dmean[big])) if big.any() else t_high
    min_area = (0.25 + 1.4 * den) * stroke_w * stroke_w
    min_area = max(min_area, 3.0)
    for i in range(1, n):
        x, y, bw, bh, a = (int(v) for v in stats[i])
        # 小噪点：面积小且不够黑（真句读点通常很黑）
        if a < min_area and dmax[i] < ref * (1.15 + 0.3 * den):
            keep[i] = False
            continue
        if a < 0.35 * min_area:
            keep[i] = False
            continue
        # 整体偏淡、面积不小的块：污渍晕/透字
        if a > 3 * stroke_w * stroke_w and dmean[i] < ref * (0.45 + 0.25 * den) and dmax[i] < ref * 1.05:
            keep[i] = False
            continue
        # 贴边的大块：扫描黑边、书口阴影
        touches = x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1
        if touches:
            fill = a / max(bw * bh, 1)
            thick = min(bw, bh) > 4 * stroke_w
            if thick and fill > 0.35:
                keep[i] = False
                continue
            # 书页侧边/上下边的暗条：贴边、细长、整条落在外缘带内
            band_x, band_y = 0.06 * w, 0.06 * h
            in_lr = (x <= 1 and x + bw <= band_x) or (x + bw >= w - 1 and x >= w - band_x)
            in_tb = (y <= 1 and y + bh <= band_y) or (y + bh >= h - 1 and y >= h - band_y)
            if (in_lr and bh > 0.15 * h) or (in_tb and bw > 0.15 * w):
                keep[i] = False
                continue
    return keep[labels]


def render(d: np.ndarray, mask: np.ndarray, t_low: float, stroke_w: float, p: InkParams) -> np.ndarray:
    """掩膜外白纸；掩膜内连续墨色，边缘留抗锯齿。"""
    inside = d[mask]
    if inside.size < 16:
        return np.full(d.shape, 255, np.uint8)
    d_ink = float(np.percentile(inside, 55))
    d_ink = max(d_ink, t_low + 0.05)
    # 渲染区域 = 掩膜外扩 1px，让边缘的过渡像素也参与
    region = cv2.dilate(mask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))).astype(bool)
    sh = float(np.clip(p.sharpen, 0.0, 1.0))
    lo = t_low * (1.0 - 0.25 * sh)
    tone = np.clip((d - lo) / max(d_ink - lo, 1e-3), 0.0, 1.0)
    # S 曲线：锐度越高越陡
    gamma = 0.9 - 0.35 * sh
    tone = tone ** gamma
    s = tone * tone * (3.0 - 2.0 * tone)
    tone = (1.0 - sh) * tone + sh * s
    out = 255.0 * (1.0 - tone)
    out[~region] = 255.0
    # 掩膜内墨心不允许发灰
    core = mask & (d >= d_ink)
    out[core] = np.minimum(out[core], 20.0)
    return np.clip(out, 0, 255).astype(np.uint8)


def extract(bgr: np.ndarray, p: InkParams) -> InkResult:
    h, w = bgr.shape[:2]
    scale = 1.0
    if min(h, w) < p.min_short_side:
        scale = min(3.0, p.min_short_side / float(min(h, w)))
        scale = max(1.0, round(scale * 2) / 2)
    work = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else bgr
    lum = luminance(work, p.stain)
    # 轻度去颗粒，不糊边
    lum = cv2.bilateralFilter(lum, 5, 18, 3)
    sw = estimate_stroke_width(lum)
    d = flat_field(lum, sw)
    mask, t_high, t_low = hysteresis_mask(d, p)
    # 补一像素断笔
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))).astype(bool)
    mask = filter_components(mask, d, sw, t_high, p)
    out = render(d, mask, t_low, sw, p)
    return InkResult(image=out, mask=mask, darkness=d, scale=scale, stroke_width=sw, t_high=t_high, t_low=t_low)
