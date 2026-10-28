"""黑帽加 Sauvola，按竖排列带去掉透字，留下真墨。连通域剔圆斑污渍。"""

from dataclasses import dataclass

import cv2
import numpy as np

from scanwash.presets import Preset, odd_clamp


@dataclass
class MaskResult:
    mask: np.ndarray
    stroke: np.ndarray
    cut: float
    peaks: list[int]
    spacing: float


def build_mask(gray: np.ndarray, preset: Preset) -> MaskResult:
    image = np.clip(gray, 0, 255).astype(np.uint8)
    height, width = image.shape
    stain = float(np.clip(getattr(preset, "stain_strength", 0.4), 0.0, 1.0))
    stroke_map = _blackhat(image)
    stroke_cut = max(10.0, float(np.percentile(stroke_map, preset.bh_percentile)))
    stroke = stroke_map >= stroke_cut
    sauvola = _sauvola(image.astype(np.float32), preset.sauvola_k)
    in_band, peaks, spacing = _column_bands(sauvola, width)
    cut = _gray_cut(image, sauvola, in_band, preset.keep_dark_pct)
    mask = _combine(image, stroke, sauvola, in_band, preset.keep_dark_pct, stain)
    mask = _filter_components(mask, height, width, peaks, spacing, stain, image, in_band)
    return MaskResult(mask=mask, stroke=stroke, cut=cut, peaks=peaks, spacing=spacing)


def _blackhat(image: np.ndarray) -> np.ndarray:
    kernel_size = odd_clamp(min(image.shape) / 200, 9, 17)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.morphologyEx(image, cv2.MORPH_BLACKHAT, kernel)


def _sauvola(image: np.ndarray, k: float) -> np.ndarray:
    window = odd_clamp(min(image.shape) / 45, 31, 81)
    mean = cv2.boxFilter(image, ddepth=-1, ksize=(window, window), borderType=cv2.BORDER_REFLECT)
    square = cv2.boxFilter(image * image, ddepth=-1, ksize=(window, window), borderType=cv2.BORDER_REFLECT)
    deviation = np.sqrt(np.maximum(square - mean * mean, 0))
    threshold = mean * (1 + k * (deviation / 128.0 - 1))
    return image < threshold


def _column_bands(sauvola: np.ndarray, width: int) -> tuple[np.ndarray, list[int], float]:
    projection = sauvola.sum(axis=0).astype(np.float32)
    sigma = max(width / 80, 1)
    kernel = int(sigma * 6) | 1
    smooth = cv2.GaussianBlur(projection.reshape(1, -1), (kernel, 1), sigmaX=sigma).ravel()
    min_distance = max(width / 30, 8)
    min_height = 0.35 * float(smooth.max()) if smooth.max() > 0 else 1.0
    peaks = _peaks(smooth, min_distance, min_height)
    in_band = np.zeros(width, dtype=bool)
    if len(peaks) < 3:
        in_band[:] = True
        return in_band, peaks, 0.0
    spacing = float(np.median(np.diff(peaks)))
    half = 0.45 * spacing
    for peak in peaks:
        start = max(0, int(round(peak - half)))
        end = min(width, int(round(peak + half)) + 1)
        in_band[start:end] = True
    return in_band, peaks, spacing


def _peaks(projection: np.ndarray, min_distance: float, min_height: float) -> list[int]:
    candidates = []
    for index in range(1, len(projection) - 1):
        height = projection[index]
        if height >= min_height and height >= projection[index - 1] and height > projection[index + 1]:
            candidates.append(index)
    candidates.sort(key=lambda item: projection[item], reverse=True)
    kept: list[int] = []
    for index in candidates:
        if all(abs(index - chosen) >= min_distance for chosen in kept):
            kept.append(index)
    kept.sort()
    return kept


def _gray_cut(image: np.ndarray, sauvola: np.ndarray, in_band: np.ndarray, keep_dark_pct: float) -> float:
    selected = sauvola[:, in_band]
    if selected.size == 0 or int(selected.sum()) < 30:
        return 100.0
    return float(np.percentile(image[:, in_band][selected], keep_dark_pct))


def _combine(
    image: np.ndarray,
    stroke: np.ndarray,
    sauvola: np.ndarray,
    in_band: np.ndarray,
    keep_dark_pct: float,
    stain: float = 0.4,
) -> np.ndarray:
    mask = np.zeros(image.shape, dtype=bool)
    for start, end in _runs(in_band):
        region_ink = sauvola[:, start:end]
        region_stroke = stroke[:, start:end]
        if int(region_ink.sum()) < 30:
            cut = 100.0
        else:
            cut = float(np.percentile(image[:, start:end][region_ink], keep_dark_pct))
        mask[:, start:end] = region_stroke | (region_ink & (image[:, start:end] < cut))
    outside = ~in_band
    if outside.any():
        # Outside columns: keep only strong stroke-like dark; stain_strength tightens further.
        outside_cut = 60.0 - 22.0 * float(np.clip(stain, 0.0, 1.0))
        mask[:, outside] |= stroke[:, outside] & (image[:, outside] < outside_cut)
    # 只用圆形核补一像素断笔。方形开运算会把撇捺切出棱角，轮廓不再用它来画。
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    return closed.astype(bool)


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    index = np.flatnonzero(flags)
    if index.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(index) > 1)
    starts = np.r_[index[0], index[breaks + 1]]
    ends = np.r_[index[breaks], index[-1]] + 1
    return list(zip(starts.tolist(), ends.tolist()))


def _filter_components(
    mask: np.ndarray,
    height: int,
    width: int,
    peaks: list[int] | None = None,
    spacing: float = 0.0,
    stain: float = 0.4,
    image: np.ndarray | None = None,
    in_band: np.ndarray | None = None,
) -> np.ndarray:
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    keep = np.zeros(count, dtype=bool)
    page_area = float(height * width)
    peaks = peaks or []
    stain = float(np.clip(stain, 0.0, 1.0))
    # Soft area caps for round blot rejection (scale with page).
    small_round = page_area * (0.00035 + 0.00055 * stain)
    mid_round = page_area * (0.0012 + 0.0018 * stain)

    for label in range(1, count):
        x, y, box_w, box_h, area = (int(v) for v in stats[label])
        if area < 16:
            continue
        touches = x <= 1 or y <= 1 or x + box_w >= width - 1 or y + box_h >= height - 1
        aspect = max(box_w, box_h) / max(min(box_w, box_h), 1)
        if touches and area > 0.005 * page_area and aspect >= 8:
            continue

        cx = float(centroids[label][0])
        near_col = True
        if peaks and spacing > 0:
            dist = min(abs(cx - float(p)) for p in peaks)
            near_col = dist <= (0.38 * spacing)

        # Circularity via perimeter of this component.
        component = (labels == label).astype(np.uint8)
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        peri = float(cv2.arcLength(contours[0], True)) if contours else 0.0
        circularity = (4.0 * np.pi * area / (peri * peri)) if peri > 1 else 0.0

        # Elongation: thin strokes are high aspect; round blotches low.
        elongation = aspect

        # Solid round blot without fine structure → stain candidate.
        if stain > 0.05:
            # Very round / blob-like away from columns
            if (not near_col) and circularity >= (0.48 - 0.08 * stain) and elongation <= (2.6 + 0.4 * stain):
                if area <= mid_round:
                    continue
            # Small round even near columns (dot mold / flyspeck)
            if circularity >= (0.62 - 0.06 * stain) and elongation <= 1.85 and area <= small_round:
                continue
            # Outside text bands: drop medium solid blobs more aggressively
            if in_band is not None and 0 <= int(cx) < width and (not bool(in_band[int(cx)])):
                if elongation <= (3.2 + stain) and area <= mid_round * 1.4 and circularity >= 0.28:
                    continue
            # Compact dark blob lacking stroke thinness: fill ratio high + low elongation
            fill = area / max(float(box_w * box_h), 1.0)
            if (
                fill >= (0.55 - 0.08 * stain)
                and elongation <= (2.1 + 0.3 * stain)
                and area <= mid_round
                and circularity >= 0.4
                and not near_col
            ):
                continue

        keep[label] = True
    return keep[labels]
