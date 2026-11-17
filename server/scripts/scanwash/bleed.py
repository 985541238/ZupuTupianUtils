"""去透字收口：只保留有深色墨芯的连通区域，纯灰背透直接刷白。"""

import cv2
import numpy as np


def suppress_bleed(
    gray: np.ndarray,
    core_threshold: int = 100,
    weak_threshold: int = 205,
    min_area: int = 24,
) -> np.ndarray:
    """用双阈值连通域去掉残余背透。

    - core：确定是正面黑字/版框的深色像素；
    - candidate：浅灰候选（可能是淡墨，也可能是背透）；
    - 只有和 core 连通的候选区域才保留，其余灰字、灰块全部刷白；
    - 最终输出纯黑白，避免大模型再把灰残影当成文字。
    """
    image = np.clip(gray, 0, 255).astype(np.uint8)
    core = image < core_threshold
    candidate = image < weak_threshold
    if not candidate.any():
        return np.full_like(image, 255)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        candidate.astype(np.uint8), connectivity=8
    )
    keep = np.zeros(count, dtype=bool)
    core_labels = np.unique(labels[core])
    keep[core_labels] = True
    if count > 0:
        keep[stats[:, cv2.CC_STAT_AREA] < min_area] = False
        keep[0] = False
    return np.where(keep[labels], 0, 255).astype(np.uint8)
