"""LAB chroma destain: push yellow/brown blotches toward paper gray before masking."""

from __future__ import annotations

import cv2
import numpy as np


def destain_gray_with_color(
    gray: np.ndarray,
    bgr: np.ndarray | None,
    stain_strength: float,
) -> np.ndarray:
    """Blend gray toward local paper where LAB a/b diverge from paper median.

    No-op when stain_strength~0 or bgr missing / size mismatch (regression path).
    """
    strength = float(np.clip(stain_strength, 0.0, 1.0))
    if strength < 0.02 or bgr is None:
        return gray.astype(np.float32) if gray.dtype != np.float32 else gray

    if bgr.shape[:2] != gray.shape[:2]:
        return gray.astype(np.float32) if gray.dtype != np.float32 else gray

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    a = lab[:, :, 1].astype(np.float32)
    b = lab[:, :, 2].astype(np.float32)

    # Paper samples: bright pixels
    paper_cut = float(np.percentile(L, 62))
    paper = L >= paper_cut
    if float(paper.mean()) < 0.08:
        paper = L >= float(np.percentile(L, 45))
    if not paper.any():
        return gray.astype(np.float32)

    a0 = float(np.median(a[paper]))
    b0 = float(np.median(b[paper]))
    dist = np.sqrt((a - a0) ** 2 + (b - b0) ** 2)

    # Lower threshold => more aggressive. OpenCV LAB a/b are centered ~128.
    # Typical mild yellow paper shift is small; mold/tea stains sit farther out.
    base_thr = 7.5 + 10.0 * (1.0 - strength)  # strength 1 → ~7.5, strength 0 → soft
    soft = np.clip((dist - base_thr) / max(6.0 + 4.0 * (1.0 - strength), 1.0), 0.0, 1.0)

    # Prefer yellowish-brown (high b) over pure red ink seals (high a, moderate b).
    yellow_bias = np.clip((b - b0) / 12.0, 0.0, 1.5)
    red_penal = np.clip((a - a0) / 18.0, 0.0, 1.0)
    soft = soft * np.clip(0.55 + 0.55 * yellow_bias - 0.35 * red_penal, 0.0, 1.0)

    # Do not bleach dark ink cores (keep floor relatively high).
    ink_floor = 55.0 + 25.0 * (1.0 - strength)
    soft = soft * np.clip((L - ink_floor) / 50.0, 0.0, 1.0)

    g = gray.astype(np.float32)
    paper_level = float(np.percentile(g[paper], 88))
    # Local paper via light blur so we do not invent a flat sheet.
    local_paper = cv2.GaussianBlur(g, (0, 0), sigmaX=max(min(g.shape) / 80.0, 1.5))
    target = np.maximum(local_paper, paper_level * 0.92)

    w = soft * (0.18 + 0.55 * strength)
    out = g * (1.0 - w) + target * w
    return np.clip(out, 0, 255).astype(np.float32)
