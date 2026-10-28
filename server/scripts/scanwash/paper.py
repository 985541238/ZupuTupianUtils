"""用闭运算估计纸色，再把光照和整页色偏除掉。支持分尺度估纸压中等污渍。"""

import cv2
import numpy as np

from scanwash.presets import Preset, odd_clamp


def normalize(gray: np.ndarray, preset: Preset) -> np.ndarray:
    """返回 float32 亮度，纸色靠近预设白点，字仍比纸暗。"""
    stain = float(np.clip(getattr(preset, "stain_strength", 0.4), 0.0, 1.0))
    background = _background(gray, preset.close_frac)
    if stain > 0.02:
        # Mid-scale close: flatten stain-sized lighting without cranking the huge kernel
        # (huge-only close tends to wash faint strokes).
        mid_frac = max(0.018, min(preset.close_frac * 0.45, preset.close_frac - 0.004))
        bg_mid = _background(gray, mid_frac)
        w = 0.12 + 0.55 * stain
        background = (1.0 - w) * background + w * np.maximum(background, bg_mid)

    background = np.maximum(background, 1.0)
    norm = gray.astype(np.float32) / background * float(np.percentile(background, 90))
    high = max(float(np.percentile(norm, 95)), 1.0)
    norm = np.clip(norm * (preset.white_target / high), 0, 255)
    if stain > 0.02:
        norm = _lift_mid_stains(norm, stain)
    return norm


def _lift_mid_stains(norm: np.ndarray, stain: float) -> np.ndarray:
    """After normalize, gently close small/mid dark blotches toward paper; protect ink edges."""
    u8 = np.clip(norm, 0, 255).astype(np.uint8)
    k = odd_clamp(5 + stain * 14, 5, 19)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    closed = cv2.morphologyEx(u8, cv2.MORPH_CLOSE, kernel)
    diff = closed.astype(np.float32) - u8.astype(np.float32)
    gx = cv2.Sobel(u8, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(u8, cv2.CV_32F, 0, 1, ksize=3)
    edge = gx * gx + gy * gy
    edge_cut = float(np.percentile(edge, 78 + 10 * (1.0 - stain)))
    # Strong edges (strokes) get almost no lift; flat mid-dark blotches get lifted.
    protect = np.clip(edge / max(edge_cut, 1.0), 0.0, 1.0)
    lift = diff * (0.22 + 0.40 * stain) * (1.0 - 0.92 * protect)
    # Only lift moderately dark paper stains, not near-black ink cores.
    inkish = u8.astype(np.float32) < (70.0 - 10.0 * stain)
    lift = np.where(inkish, lift * 0.02, lift)
    return np.clip(u8.astype(np.float32) + lift, 0, 255)


def _background(gray: np.ndarray, close_frac: float) -> np.ndarray:
    """背景在缩小图上估计。核和字一起缩小，仍然大于一个字、小于大块污渍。"""
    height, width = gray.shape
    full_kernel = odd_clamp(min(height, width) * close_frac, 61, 151)
    scale = min(1.0, 1600 / max(height, width))
    if scale < 1:
        small = cv2.resize(
            gray,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
        kernel_size = odd_clamp(full_kernel * scale, 15, 151)
    else:
        small = gray
        kernel_size = full_kernel
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    closed = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    closed = cv2.GaussianBlur(closed, (0, 0), sigmaX=max(kernel_size / 6, 0.8))
    if scale < 1:
        closed = cv2.resize(closed, (width, height), interpolation=cv2.INTER_LINEAR)
    return closed.astype(np.float32)
