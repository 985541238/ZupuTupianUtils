"""透视拉正、纠偏，以及残页的文字块裁切。"""

from dataclasses import dataclass

import cv2
import numpy as np

from scanwash.presets import odd_clamp


@dataclass
class GeometryResult:
    gray: np.ndarray
    angle: float
    warnings: list[str]
    outside_ratio: float


def correct(bgr: np.ndarray, tier: str) -> GeometryResult:
    """老化档在有黑边或红边时透视；干净档和老化档再纠偏。残页保持原几何。"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if tier == "damaged":
        return GeometryResult(gray=gray, angle=0.0, warnings=[], outside_ratio=0.0)

    warnings: list[str] = []
    outside_ratio = 0.0
    if tier == "aged":
        quad, outside_ratio, page_ratio = _detect_page(bgr)
        if quad is not None and page_ratio < 0.97:
            gray = cv2.cvtColor(_warp(bgr, quad), cv2.COLOR_BGR2GRAY)
        elif outside_ratio > 0.05 and page_ratio < 0.97:
            warnings.append("geometry_skipped")

    angle = _skew_angle(gray)
    if abs(angle) >= 0.3:
        gray = _rotate(gray, angle)
    else:
        angle = 0.0
    return GeometryResult(gray=gray, angle=angle, warnings=warnings, outside_ratio=outside_ratio)


def crop_text_block(
    gray: np.ndarray, mask: np.ndarray, stroke: np.ndarray
) -> tuple[np.ndarray, np.ndarray, bool]:
    """按笔画的列投影裁出文字块。裁切边切断笔画时返回 text_loss。"""
    height, width = mask.shape
    projection = stroke.sum(axis=0).astype(np.float32)
    if projection.max() < 5:
        projection = mask.sum(axis=0).astype(np.float32)
    if projection.max() <= 0:
        return gray, mask, True

    columns = np.flatnonzero(projection >= 0.3 * projection.max())
    if columns.size == 0:
        return gray, mask, True
    x0, x1 = int(columns[0]), int(columns[-1])
    rows = np.flatnonzero(mask[:, x0 : x1 + 1].sum(axis=1) >= 3)
    if rows.size == 0:
        return gray, mask, True
    y0, y1 = int(rows[0]), int(rows[-1])

    loss = _edge_cuts_strokes(mask, x0, y0, x1, y1)
    pad_x = int(round(0.04 * width))
    pad_y = int(round(0.04 * height))
    x0 = max(0, x0 - pad_x)
    y0 = max(0, y0 - pad_y)
    x1 = min(width - 1, x1 + pad_x)
    y1 = min(height - 1, y1 + pad_y)
    if x1 - x0 < 10 or y1 - y0 < 10:
        return gray, mask, True

    cropped_mask = mask[y0 : y1 + 1, x0 : x1 + 1]
    if _border_strip_dense(cropped_mask):
        loss = True
    return gray[y0 : y1 + 1, x0 : x1 + 1], cropped_mask, loss


def _detect_page(bgr: np.ndarray) -> tuple[np.ndarray | None, float, float]:
    """返回满分辨率四角、页外像素占比、亮页轮廓占缩略图的比例。"""
    height, width = bgr.shape[:2]
    scale = min(1.0, 1200 / max(height, width))
    small = cv2.resize(
        bgr,
        (max(1, int(width * scale)), max(1, int(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0]
    red = ((hue <= 10) | (hue >= 170)) & (hsv[:, :, 1] > 80) & (hsv[:, :, 2] > 40)
    outside = (gray < 60) | red
    outside_ratio = float(outside.mean())
    if outside_ratio <= 0.05:
        return None, outside_ratio, 1.0

    page = np.where(outside, 0, 255).astype(np.uint8)
    kernel_size = odd_clamp(min(page.shape) * 0.025, 15, 41)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    page = cv2.morphologyEx(page, cv2.MORPH_CLOSE, kernel)
    contours, _hierarchy = cv2.findContours(page, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, outside_ratio, 0.0

    contour = max(contours, key=cv2.contourArea)
    page_ratio = float(cv2.contourArea(contour) / page.size)
    if page_ratio >= 0.97 or page_ratio < 0.40:
        return None, outside_ratio, page_ratio

    quad = _four_corners(contour)
    if quad is None:
        return None, outside_ratio, page_ratio
    return quad / scale, outside_ratio, page_ratio


def _four_corners(contour: np.ndarray) -> np.ndarray | None:
    perimeter = cv2.arcLength(contour, True)
    for factor in (0.02, 0.015, 0.03, 0.04):
        approx = cv2.approxPolyDP(contour, factor * perimeter, True)
        if len(approx) == 4:
            return _order_quad(approx.reshape(4, 2))
    box = cv2.boxPoints(cv2.minAreaRect(contour))
    return _order_quad(box)


def _order_quad(points: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)
    ordered = np.zeros((4, 2), dtype=np.float32)
    total = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    ordered[0] = pts[np.argmin(total)]
    ordered[2] = pts[np.argmax(total)]
    ordered[1] = pts[np.argmin(diff)]
    ordered[3] = pts[np.argmax(diff)]
    return ordered


def _warp(bgr: np.ndarray, quad: np.ndarray) -> np.ndarray:
    top_left, top_right, bottom_right, bottom_left = quad
    out_w = int(round(max(np.linalg.norm(top_right - top_left), np.linalg.norm(bottom_right - bottom_left))))
    out_h = int(round(max(np.linalg.norm(bottom_left - top_left), np.linalg.norm(bottom_right - top_right))))
    out_w = max(out_w, 1)
    out_h = max(out_h, 1)
    src_h, src_w = bgr.shape[:2]
    if out_w > src_w or out_h > src_h:
        scale = min(src_w / out_w, src_h / out_h)
        out_w = max(1, int(out_w * scale))
        out_h = max(1, int(out_h * scale))
    destination = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
        dtype=np.float32,
    )
    transform = cv2.getPerspectiveTransform(quad.astype(np.float32), destination)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    paper = int(np.percentile(gray, 75))
    return cv2.warpPerspective(
        bgr,
        transform,
        (out_w, out_h),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(paper, paper, paper),
    )


def _skew_angle(gray: np.ndarray) -> float:
    """在 ±2.5° 内找让竖排列投影最整齐的角度。增益不足 5% 时不转。"""
    long_side = max(gray.shape)
    scale = min(1.0, 900 / long_side)
    small = cv2.resize(
        gray,
        (max(1, int(gray.shape[1] * scale)), max(1, int(gray.shape[0] * scale))),
        interpolation=cv2.INTER_AREA,
    )
    base = _projection_var(_quick_ink(small))
    best_angle = 0.0
    best_var = base
    for step in range(-10, 11):
        angle = step * 0.25
        if angle == 0:
            continue
        varied = _projection_var(_quick_ink(_rotate(small, angle)))
        if varied > best_var:
            best_angle = angle
            best_var = varied
    if abs(best_angle) < 0.3 or best_var < base * 1.05:
        return 0.0
    return best_angle


def _quick_ink(gray: np.ndarray) -> np.ndarray:
    window = odd_clamp(min(gray.shape) / 40, 21, 41)
    image = gray.astype(np.float32)
    mean = cv2.boxFilter(image, ddepth=-1, ksize=(window, window), borderType=cv2.BORDER_REFLECT)
    square = cv2.boxFilter(image * image, ddepth=-1, ksize=(window, window), borderType=cv2.BORDER_REFLECT)
    deviation = np.sqrt(np.maximum(square - mean * mean, 0))
    threshold = mean * (1 + 0.2 * (deviation / 128.0 - 1))
    return image < threshold


def _projection_var(ink: np.ndarray) -> float:
    projection = ink.sum(axis=0).astype(np.float64)
    return float(projection.var())


def _rotate(gray: np.ndarray, angle: float) -> np.ndarray:
    height, width = gray.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    fill = int(np.median(gray))
    return cv2.warpAffine(
        gray,
        matrix,
        (width, height),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=fill,
    )


def _edge_cuts_strokes(mask: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> bool:
    height, width = mask.shape
    margin_x = max(2, int(0.02 * width))
    margin_y = max(2, int(0.02 * height))
    touches = (
        x0 <= margin_x
        or y0 <= margin_y
        or x1 >= width - 1 - margin_x
        or y1 >= height - 1 - margin_y
    )
    if not touches:
        return False
    edge = np.concatenate(
        [
            mask[y0, x0 : x1 + 1],
            mask[y1, x0 : x1 + 1],
            mask[y0 : y1 + 1, x0],
            mask[y0 : y1 + 1, x1],
        ]
    )
    return bool(edge.size and edge.mean() > 0.02)


def _border_strip_dense(mask: np.ndarray) -> bool:
    if mask.size == 0:
        return True
    strips = (mask[:4, :], mask[-4:, :], mask[:, :4], mask[:, -4:])
    return any(strip.size and float(strip.mean()) > 0.03 for strip in strips)
