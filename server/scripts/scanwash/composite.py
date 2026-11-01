"""把墨迹合成到白纸上，笔画内部压暗，边缘留一圈灰阶。"""

import cv2
import numpy as np


def composite(gray: np.ndarray, mask: np.ndarray, cut: float, sharpen: float) -> tuple[np.ndarray, np.ndarray]:
    """返回 float32 成品和同尺寸的不透明度。掩膜外是白纸。

    轮廓跟归一化后的灰度走，不跟二值掩膜走。方形掩膜会把撇捺切成棱角，
    再在抹平的结果上锐化也拉不回笔画。
    """
    image = gray.astype(np.float32)
    if int(mask.sum()) < 16:
        return np.full(image.shape, 255, dtype=np.float32), np.zeros(image.shape, dtype=np.float32)

    # 3 像素圆形闭运算只填笔画内部的小孔，不把相邻笔画粘在一起，也不补整段缺笔。
    solid = _fill_stroke_holes(image)
    smooth = _smooth_edges(solid).astype(np.float32)
    wide = cv2.GaussianBlur(smooth, (0, 0), 0.9)
    crisp = np.clip(smooth + float(sharpen) * 1.6 * (smooth - wide), 0, 255)

    inside = crisp[mask]
    outside = crisp[~mask]
    black = float(np.percentile(inside, 30))
    paper = float(np.percentile(outside, 40)) if outside.size else black + 80.0
    white = black + max(paper - black, 24.0) * 0.58
    tone = np.clip((crisp - black) / (white - black), 0.0, 1.0)
    ink = 255.0 * tone

    # 细笔的灰边贴着墨心，这段过渡要留下来，轮廓才不会收成一个像素。
    # 远离墨心的浅灰才是透字。
    core = crisp <= (black + 8.0)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    near = cv2.dilate(core.astype(np.uint8), kernel).astype(bool)
    out = ink.copy()
    out[(~near) & (out < 252)] = 255.0
    alpha = 1.0 - out / 255.0
    return out.astype(np.float32), alpha


def _smooth_edges(image: np.ndarray) -> np.ndarray:
    """笔画越大，平滑半径越大，用来去掉字心颗粒，墨色和纸色的交界仍留着。"""
    scale = max(min(image.shape) / 480, 1.0)
    diameter = int(round(5 * scale))
    if diameter % 2 == 0:
        diameter += 1
    diameter = min(diameter, 9)
    return cv2.bilateralFilter(image, d=diameter, sigmaColor=24, sigmaSpace=diameter)


def _fill_stroke_holes(image: np.ndarray) -> np.ndarray:
    ink = cv2.bitwise_not(np.clip(image, 0, 255).astype(np.uint8))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    filled = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, kernel)
    return cv2.bitwise_not(filled)


def refine_thin_strokes(image: np.ndarray) -> np.ndarray:
    """细字放大两倍后，用距离场把边缘收成平滑曲线。

    只处理笔画半径不超过 2.4 像素的字。更粗的字留在原图上，
    避免把木刻大字的颗粒抹掉或把笔画改细。没有足够细字时原样返回。
    """
    gray = np.clip(image, 0, 255).astype(np.uint8)
    core = (gray < 100).astype(np.uint8)
    if int(core.sum()) < 64:
        return gray
    distance = cv2.distanceTransform(core, cv2.DIST_L2, 5)
    count, labels = cv2.connectedComponents(core, connectivity=8)
    peaks = np.zeros(count, np.float32)
    np.maximum.at(peaks, labels.ravel(), distance.ravel())
    thin_label = peaks <= 2.4
    thin_label[0] = False
    thin = thin_label[labels]
    if int(thin.sum()) < 64:
        return gray

    # 长边超过约 3600 的页面不再放大，避免成品尺寸翻倍后过大。
    scale = 2 if max(gray.shape) <= 3600 else 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    thin_u8 = cv2.morphologyEx(thin.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    big = cv2.resize(thin_u8, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    inside = cv2.distanceTransform(big, cv2.DIST_L2, 5)
    outside = cv2.distanceTransform(1 - big, cv2.DIST_L2, 5)
    field = cv2.GaussianBlur(inside - outside, (0, 0), 0.7 * scale)
    field = np.where(inside >= 0.8 * scale, np.maximum(field, 0.6 * scale), field)
    cover = np.clip(0.5 + field / (1.4 * scale), 0.0, 1.0)
    cover = cover * cover * (3.0 - 2.0 * cover)
    smooth = 255.0 * (1.0 - cover)
    base = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)
    out = np.where(cover > 0.08, smooth, base)
    return np.clip(out, 0, 255).astype(np.uint8)


def apply_gutter(
    image: np.ndarray, alpha: np.ndarray, peaks: list[int], spacing: float
) -> tuple[np.ndarray, bool]:
    """对开中缝的纸面加一条最多 14 灰阶的暗带。字不动。"""
    if len(peaks) < 3 or spacing <= 1:
        return image, False
    _height, width = image.shape
    lo, hi = width * 0.30, width * 0.70
    best_gap = 0.0
    best_mid = 0.0
    ordered = sorted(peaks)
    for left, right in zip(ordered, ordered[1:]):
        gap = right - left
        mid = 0.5 * (left + right)
        left_count = sum(peak < mid for peak in ordered)
        right_count = sum(peak > mid for peak in ordered)
        # 两侧都有文字列，才是对开书缝。单页里的大块空白不画阴影。
        if (
            gap > 1.6 * spacing
            and lo <= mid <= hi
            and gap > best_gap
            and left_count >= 3
            and right_count >= 3
        ):
            best_gap = gap
            best_mid = mid
    if best_gap <= 0:
        return image, False

    # 书缝本身很窄。缝再宽，暗带也只留在折痕上，不把空白页染灰。
    sigma = min(max(best_gap / 6.0, 1.0), 16.0)
    xs = np.arange(width, dtype=np.float32)
    shade = 14.0 * np.exp(-0.5 * ((xs - best_mid) / sigma) ** 2)
    out = image.copy()
    paper = alpha < 0.15
    tiled = np.broadcast_to(shade, out.shape)
    out[paper] = np.clip(out[paper] - tiled[paper], 0, 255)
    return out, True
