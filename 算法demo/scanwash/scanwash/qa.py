"""成品数值验收。任一警告都会把该页送进 review。"""

import numpy as np

PAPER_P50_MIN = 245.0
INK_P50_MAX = 70.0
MASK_RATIO_MIN = 0.005
MASK_RATIO_MAX = 0.22


def evaluate(
    image: np.ndarray,
    mask: np.ndarray,
    alpha: np.ndarray,
    tier: str,
    warnings: list[str],
) -> dict:
    hard = mask.astype(bool)
    paper = alpha < 0.15
    ratio = float(hard.mean()) if hard.size else 0.0
    paper_p50 = float(np.median(image[paper])) if paper.any() else 0.0
    ink_p50 = float(np.median(image[hard])) if hard.any() else 255.0

    if ratio < MASK_RATIO_MIN:
        _add(warnings, "sparse_text")
    if ratio > MASK_RATIO_MAX:
        _add(warnings, "mask_exploded")
    if ink_p50 > INK_P50_MAX:
        _add(warnings, "ink_light")
    if paper_p50 < PAPER_P50_MIN:
        _add(warnings, "paper_dark")
    if tier == "damaged":
        _add(warnings, "damaged_page")

    return {
        "paper_p50": round(paper_p50, 1),
        "ink_p50": round(ink_p50, 1),
        "mask_ratio": round(ratio, 4),
        "review": bool(warnings),
    }


def _add(warnings: list[str], name: str) -> None:
    if name not in warnings:
        warnings.append(name)
