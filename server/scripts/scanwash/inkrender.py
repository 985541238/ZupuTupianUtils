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
    info: dict | None = None


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


def hysteresis_mask(d: np.ndarray, p: InkParams, local_sw: float = 0.0) -> tuple[np.ndarray, float, float]:
    cand = d[d > 0.06]
    t = _otsu01(cand)
    sens = float(np.clip(p.sensitivity, 0.0, 1.0))
    # 敏感度 0.5 → 强阈值 = Otsu；越敏感越低
    t_high = float(np.clip(t * (1.35 - 0.7 * sens), 0.10, 0.85))
    t_low = float(np.clip(t_high * (0.62 - 0.22 * sens), 0.05, t_high - 0.02))
    strong = (d >= t_high).astype(np.uint8)
    weak = (d >= t_low).astype(np.uint8)
    # 局部种子：整页统一的强阈值会让「整片都偏淡」的区域（复印不清的几列字）一个种子都没有，
    # 这些字整块被丢掉。按局部（约 10 个笔宽的格子）墨色高位再补一层种子；
    # 格子里本来就没什么墨（空白、纸张噪点）的不补。
    if local_sw:
        tile = int(max(24, 10 * local_sw))
        h, w = d.shape
        gh, gw = max(1, h // tile), max(1, w // tile)
        small = cv2.resize(d, (gw * 2, gh * 2), interpolation=cv2.INTER_AREA) if gw * gh > 1 else d
        # 局部高位：每个小格取块内 92 分位，用大一圈的最大值滤波平滑
        blk = cv2.resize(d, (max(1, w // max(2, tile // 2)), max(1, h // max(2, tile // 2))), interpolation=cv2.INTER_AREA)
        loc = cv2.dilate(blk, np.ones((3, 3), np.uint8))
        loc = cv2.resize(loc, (w, h), interpolation=cv2.INTER_LINEAR)
        ok_tile = loc >= 0.10
        local_seed = (d >= np.maximum(0.62 * loc, 0.5 * t_high)) & ok_tile & (d >= t_low * 1.15)
        strong = (strong.astype(bool) | local_seed).astype(np.uint8)
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
        # 贴边的大块：扫描仪黑底、书口阴影。只删“沿着那条边”的条带或实心黑块，
        # 横贯整页的边框粗线、被裁到的邻页标题列都保留。
        fill = a / max(bw * bh, 1)
        at_l, at_r = x <= 1, x + bw >= w - 1
        at_t, at_b = y <= 1, y + bh >= h - 1
        side_strip = (at_l or at_r) and bh > 0.3 * h and bw < 0.08 * w and fill > 0.5
        tb_strip = (at_t or at_b) and bw > 0.3 * w and bh < 0.08 * h and fill > 0.5
        solid_bg = (at_l or at_r or at_t or at_b) and a > 0.01 * h * w and fill > 0.6 and dmean[i] > ref * 0.9
        if side_strip or tb_strip or solid_bg:
            keep[i] = False
            continue
    return keep[labels]


def remove_stain_blobs(mask: np.ndarray, lum: np.ndarray, stroke_w: float, p: InkParams) -> tuple[np.ndarray, int]:
    """霉斑、水渍、墨渍团：比笔画粗得多、轮廓破碎的黑块。

    用直径约 2.6 倍笔宽的圆盘做开运算，笔画会被整笔开掉，只剩粗块。
    粗块里外形规整的（世系框、黑底标签、粗边框）保留；轮廓破碎的判为污渍。
    污渍范围内不直接清空：字常压在污渍上，按局部灰度重新二分，墨比污渍黑就留下。
    """
    strength = float(np.clip(p.stain, 0.0, 1.0))
    if strength < 0.05:
        return mask, 0
    D = int(round(2.6 * stroke_w)) | 1
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (D, D))
    opened = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, disk)
    n, lab, st, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    if n <= 1:
        return mask, 0
    solid_min = 0.70 + 0.15 * strength
    bad = np.zeros(n, bool)
    for i in range(1, n):
        x, y, bw, bh, a = (int(v) for v in st[i])
        if max(bw, bh) > 30 * stroke_w or max(bw, bh) / max(min(bw, bh), 1) > 5:
            continue  # 边框线、书口折线
        comp = (lab[y : y + bh, x : x + bw] == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c0 = max(cnts, key=cv2.contourArea)
        hull_area = cv2.contourArea(cv2.convexHull(c0))
        solidity = cv2.contourArea(c0) / max(hull_area, 1.0)
        bad[i] = solidity < solid_min
    if not bad.any():
        return mask, 0
    blob = bad[lab].astype(np.uint8)
    r = int(round(0.9 * stroke_w)) * 2 + 1
    zone = cv2.dilate(blob, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (r, r))).astype(bool)
    zone &= mask
    out = mask & ~zone
    # 污渍区内重新分墨：每块单独做 Otsu，墨明显比污渍黑才留
    zl = lum.astype(np.float32)
    nz, zlab = cv2.connectedComponents(zone.astype(np.uint8), connectivity=8)
    for j in range(1, nz):
        sel = zlab == j
        vals = zl[sel]
        if vals.size < 50:
            continue
        u8 = np.clip(vals, 0, 255).astype(np.uint8).reshape(-1, 1)
        t, _ = cv2.threshold(u8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        dark = vals[vals < t]
        light = vals[vals >= t]
        if dark.size < 20 or light.size < 20:
            continue
        if float(light.mean() - dark.mean()) < 45.0:
            continue  # 墨和污渍一样黑，分不开，整块按污渍处理
        keep = sel & (zl < t - 6.0)
        out |= keep
    # 重新分出的碎点去掉
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    out = cv2.morphologyEx(out.astype(np.uint8), cv2.MORPH_OPEN, k3).astype(bool) | (mask & ~zone & out)
    return out, int(bad.sum())


def _close_bg(lum: np.ndarray, k: int) -> np.ndarray:
    """大核闭运算估计纸面亮度。背景是缓变的，在缩小图上做再放大回去，结果几乎一样、快很多。"""
    f = max(1, k // 15)
    if f <= 1:
        return cv2.morphologyEx(lum, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    h, w = lum.shape[:2]
    small = cv2.resize(lum, (max(1, w // f), max(1, h // f)), interpolation=cv2.INTER_AREA)
    # 缩小时用 AREA 会把细笔画“冲淡”，先在原图上做一次小核闭运算抹掉笔画再缩
    pre = cv2.morphologyEx(lum, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (f * 2 + 1, f * 2 + 1)))
    small = cv2.resize(pre, (max(1, w // f), max(1, h // f)), interpolation=cv2.INTER_AREA)
    ks = max(3, int(k / f)) | 1
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks)))
    return cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)


def split_stain_layer(mask: np.ndarray, lum: np.ndarray, stroke_w: float, p: InkParams) -> tuple[np.ndarray, dict]:
    """逐个连通域区分“字”和“污渍”。

    刻本字边缘是刀刻出来的，墨和纸之间一步到位；霉斑、水渍、折痕边缘是渐变的。
    用“边界平均梯度 / 该块与纸的反差”衡量边缘锐利度，与反差无关，淡墨字也成立。
    - 锐利：字，原样保留（淡墨字也不动）。
    - 发虚且没有墨黑的核心：纯污渍，整块去掉。
    - 发虚但有墨黑核心：字黏着污渍，只留墨黑核心再向外长半个笔宽。
    """
    info: dict = {"stain_layer": False}
    strength = float(np.clip(p.stain, 0.0, 1.0))
    if strength < 0.1 or int(mask.sum()) < 500:
        return mask, info
    m8 = mask.astype(np.uint8)
    lum = lum.astype(np.float32)
    k_bg = int(7 * stroke_w) | 1
    bg = _close_bg(lum, k_bg)
    gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1)
    gm = np.sqrt(gx * gx + gy * gy)
    edge = (m8 - cv2.erode(m8, np.ones((3, 3), np.uint8))).astype(bool)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m8, connectivity=8)
    area = np.maximum(st[:, cv2.CC_STAT_AREA].astype(np.float64), 1)
    flat = lab.ravel()
    gmean = np.bincount(flat, lum.ravel(), n) / area
    bgm = np.bincount(flat, bg.ravel(), n) / area
    ecnt = np.maximum(np.bincount(lab[edge], minlength=n), 1)
    esh = np.bincount(lab[edge], gm[edge], n) / ecnt
    contrast = np.maximum(bgm - gmean, 5.0)
    sharp = esh / contrast
    sizable = area >= 2 * stroke_w * stroke_w
    sizable[0] = False
    if sizable.sum() < 10:
        return mask, info
    # 页面参考：高反差块的锐利度（按面积加权中位数）
    hi = sizable & (contrast >= np.percentile(contrast[sizable], 60))
    order = np.argsort(sharp[hi])
    cw = np.cumsum(area[hi][order])
    ref = float(sharp[hi][order][np.searchsorted(cw, cw[-1] / 2)])
    # 墨黑阈值：掩膜内亮度 Otsu
    vals = np.clip(lum[mask], 0, 255).astype(np.uint8).reshape(-1, 1)
    t_ink, _ = cv2.threshold(vals, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    soft_thr = ref * (0.80 + 0.08 * strength)
    soft = sizable & (sharp < soft_thr)
    # 小碎块：只按锐利度判断
    tiny = ~sizable
    tiny[0] = False
    tiny_soft = tiny & (sharp < ref * 0.75)
    info.update(ref_sharp=round(ref, 2), ink_cut=float(t_ink))
    if not soft.any() and not tiny_soft.any():
        return mask, info
    info["stain_layer"] = True
    soft_px = soft[lab]
    core = (soft_px & (lum < float(t_ink))).astype(np.uint8)
    nc, clab, cst, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
    okc = cst[:, cv2.CC_STAT_AREA] >= max(4, int(0.6 * stroke_w * stroke_w))
    okc[0] = False
    core = okc[clab].astype(np.uint8)
    region = soft_px.astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    grown = core
    for _ in range(max(1, int(round(0.5 * stroke_w)))):
        grown = cv2.dilate(grown, k) & region
    keep_lbl = ~(soft | tiny_soft)
    keep_lbl[0] = False
    out = keep_lbl[lab] | grown.astype(bool)
    info.update(soft_components=int(soft.sum()), tiny_dropped=int(tiny_soft.sum()))
    return out, info


def rescue_faint(mask: np.ndarray, d: np.ndarray, t_low: float, stroke_w: float, p: InkParams) -> tuple[np.ndarray, np.ndarray, dict]:
    """淡墨/复印不清的笔画补回并加深。

    只在字旁边补：比正常阈值更淡、但紧贴着已认定的字（在 2.5 倍笔宽之内）的淡笔画才补回；
    离字很远的淡块（污渍、透字）一概不补。整页如果有不少远离字的淡块（说明是脏页），整体不启用，
    脏页的淡斑本来就不该留。补回来的笔画渲染时直接按深色处理，不会再是一团灰。
    """
    info = {"faint_rescued": 0}
    sens = float(np.clip(p.sensitivity, 0.0, 1.0))
    if mask.sum() < 500:
        return mask, np.zeros_like(mask), info
    t_vw = max(0.045, t_low * (0.62 - 0.15 * sens))
    vw = (d >= t_vw)
    near_r = int(round(2.5 * stroke_w)) | 1
    near = cv2.dilate(mask.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (near_r, near_r))).astype(bool)
    n, lab, st, _ = cv2.connectedComponentsWithStats((vw & ~mask).astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask, np.zeros_like(mask), info
    area = st[:, cv2.CC_STAT_AREA].astype(np.float64)
    flat = lab.ravel()
    in_near = np.bincount(flat, weights=near.ravel().astype(np.float64), minlength=n) / np.maximum(area, 1)
    cand = np.ones(n, bool)
    cand[0] = False
    cand &= area >= max(4.0, 0.3 * stroke_w * stroke_w)
    cand &= area <= 40 * stroke_w * stroke_w
    far = cand & (in_near < 0.2)
    ok = cand & (in_near >= 0.5)
    # 脏页判断：远离字的淡块面积占字面积的比例
    if area[far].sum() > 0.35 * float(mask.sum()):
        info["faint_skipped_dirty"] = True
        return mask, np.zeros_like(mask), info
    resc = ok[lab] & near
    info["faint_rescued"] = int(ok.sum())
    return mask | resc, resc, info


def render(d: np.ndarray, mask: np.ndarray, t_low: float, stroke_w: float, p: InkParams, rescued: np.ndarray | None = None) -> np.ndarray:
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
    if rescued is not None and rescued.any():
        # 补回的淡笔画加深：按它自己的浓淡拉到 0.7~1 的墨色
        rd = np.clip((d - 0.0) / max(t_low, 1e-3), 0.0, 1.0)
        tone = np.where(rescued, np.maximum(tone, 0.7 + 0.3 * rd), tone)
        region = region | cv2.dilate(rescued.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))).astype(bool)
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
    mask, t_high, t_low = hysteresis_mask(d, p, sw)
    # 补一像素断笔
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))).astype(bool)
    lum_raw = luminance(work, p.stain)
    lum_med = cv2.medianBlur(np.clip(lum_raw, 0, 255).astype(np.uint8), 3)
    mask, _blobs = remove_stain_blobs(mask, lum_med, sw, p)
    mask, layer_info = split_stain_layer(mask, lum_med.astype(np.float32), sw, p)
    mask = filter_components(mask, d, sw, t_high, p)
    mask, rescued, faint_info = rescue_faint(mask, d, t_low, sw, p)
    out = render(d, mask, t_low, sw, p, rescued)
    return InkResult(
        image=out, mask=mask, darkness=d, scale=scale, stroke_width=sw, t_high=t_high, t_low=t_low,
        info={"stain_blobs": _blobs, **layer_info, **faint_info},
    )
