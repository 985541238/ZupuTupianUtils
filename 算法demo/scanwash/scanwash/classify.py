"""按纸色、边框和破损把页面分成干净、老化、残页。

阈值用目录里 10 张原图锁过：黄度够得到卷7，黑边够得到卷2，
格子亮度散开够得到卷21，其余落在干净档。
"""

from dataclasses import asdict, dataclass

import cv2
import numpy as np

# OpenCV LAB 的 b，128 为中性。140 约等于 CIE b = 12。
YELLOW_B_MIN = 140
PAPER_L_MIN = 191
BORDER_MAX = 150
BORDER_DELTA = 60
CELL_STD_MIN = 18.0
CELL_MIN_MAX = 160.0
WHITE_LEVEL = 242
WHITE_LOW = 0.10
WHITE_HIGH = 0.70


@dataclass(frozen=True)
class PageFeatures:
    yellow_b: float
    border_mean: float
    center_mean: float
    cell_std: float
    cell_min: float
    white_ratio: float

    def to_dict(self) -> dict:
        return {key: round(float(value), 2) for key, value in asdict(self).items()}


def classify(bgr: np.ndarray) -> tuple[str, PageFeatures]:
    """在长边约 1/8 的缩略图上分档。返回档位和特征。"""
    height, width = bgr.shape[:2]
    small = cv2.resize(
        bgr,
        (max(1, width // 8), max(1, height // 8)),
        interpolation=cv2.INTER_AREA,
    )
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lab_b = cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[:, :, 2]
    lightness = cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[:, :, 0]
    paper = lightness > PAPER_L_MIN
    if float(paper.mean()) > 0.3:
        yellow_b = float(np.median(lab_b[paper]))
    else:
        yellow_b = float(np.median(lab_b))

    grid_h = max(1, gray.shape[0] // 25)
    grid_w = max(1, gray.shape[1] // 25)
    border = np.concatenate(
        [
            gray[:grid_h, :].ravel(),
            gray[-grid_h:, :].ravel(),
            gray[:, :grid_w].ravel(),
            gray[:, -grid_w:].ravel(),
        ]
    )
    center = gray[grid_h:-grid_h, grid_w:-grid_w]
    border_mean = float(border.mean())
    center_mean = float(center.mean()) if center.size else border_mean

    cell_means = _cell_means(gray, 8)
    white_ratio = float((gray > WHITE_LEVEL).mean())
    features = PageFeatures(
        yellow_b=yellow_b,
        border_mean=border_mean,
        center_mean=center_mean,
        cell_std=float(cell_means.std()),
        cell_min=float(cell_means.min()),
        white_ratio=white_ratio,
    )

    if features.yellow_b >= YELLOW_B_MIN:
        tier = "aged"
    elif features.border_mean < BORDER_MAX and features.center_mean - features.border_mean > BORDER_DELTA:
        tier = "aged"
    elif (
        features.cell_std >= CELL_STD_MIN
        and features.cell_min < CELL_MIN_MAX
        and WHITE_LOW < features.white_ratio < WHITE_HIGH
    ):
        tier = "damaged"
    else:
        tier = "clean"
    return tier, features


def _cell_means(gray: np.ndarray, divisions: int) -> np.ndarray:
    height, width = gray.shape
    means = np.empty(divisions * divisions, dtype=np.float32)
    index = 0
    for row in range(divisions):
        y0 = row * height // divisions
        y1 = (row + 1) * height // divisions
        for col in range(divisions):
            x0 = col * width // divisions
            x1 = (col + 1) * width // divisions
            means[index] = gray[y0:y1, x0:x1].mean()
            index += 1
    return means
