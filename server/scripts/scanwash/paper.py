"""用闭运算估计纸色，再把光照和整页色偏除掉。"""

import cv2
import numpy as np

from scanwash.presets import Preset, odd_clamp


def normalize(gray: np.ndarray, preset: Preset) -> np.ndarray:
    """返回 float32 亮度，纸色靠近预设白点，字仍比纸暗。"""
    background = _background(gray, preset.close_frac)
    background = np.maximum(background, 1.0)
    norm = gray.astype(np.float32) / background * float(np.percentile(background, 90))
    high = max(float(np.percentile(norm, 95)), 1.0)
    return np.clip(norm * (preset.white_target / high), 0, 255)


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
