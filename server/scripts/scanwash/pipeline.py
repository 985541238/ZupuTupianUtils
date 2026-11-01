"""把分档、拉正、墨迹提取和验收串成一页。"""

import os
import time
from pathlib import Path

import cv2
import numpy as np

from dataclasses import asdict

from scanwash.classify import classify
from scanwash.geometry import correct, crop_text_block
from scanwash.inkrender import InkParams, extract
from scanwash.presets import PRESETS
from scanwash.qa import evaluate


def imread(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"无法读取图片: {path.name}")
    return image


def imwrite_gray(path: Path, gray: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(".png", gray)
    if not ok:
        raise RuntimeError(f"无法编码: {path.name}")
    encoded.tofile(str(path))


def process_page(source: np.ndarray, tier: str, params: InkParams, auto_crop: bool = False) -> tuple[np.ndarray, dict]:
    """拉正 → 墨迹提取（掩膜严格约束成品）→ 可选裁文字块 → 验收。"""
    # 内存保护：超大图（默认 > 1200 万像素）按缩小的尺寸处理，结果再放回原尺寸。
    # 笔画粗细由算法自适应，缩小后效果基本一致，但峰值内存与耗时大幅下降。
    src_h0, src_w0 = source.shape[:2]
    max_px = float(os.environ.get("ZW_MAX_PIXELS", "12000000"))
    down = 1.0
    if max_px > 0 and src_h0 * src_w0 > max_px:
        down = (max_px / float(src_h0 * src_w0)) ** 0.5
        source = cv2.resize(source, (max(1, int(round(src_w0 * down))), max(1, int(round(src_h0 * down)))), interpolation=cv2.INTER_AREA)
    geometry = correct(source, tier)
    work = geometry.bgr if geometry.bgr is not None else cv2.cvtColor(geometry.gray, cv2.COLOR_GRAY2BGR)
    result = extract(work, params)
    image, mask = result.image, result.mask
    if down < 1.0 and not auto_crop and image.shape[:2] == source.shape[:2]:
        image = cv2.resize(image, (src_w0, src_h0), interpolation=cv2.INTER_LINEAR)
        mask = cv2.resize(mask.astype(np.uint8), (src_w0, src_h0), interpolation=cv2.INTER_NEAREST).astype(bool)
    warnings = list(geometry.warnings)
    if auto_crop:
        image, mask, loss = crop_text_block(image, mask, mask)
        if loss:
            warnings.append("text_loss_risk")
    alpha = 1.0 - image.astype(np.float32) / 255.0
    metrics = evaluate(image.astype(np.float32), mask, alpha, tier, warnings)
    meta = {
        "warnings": warnings,
        "paper_p50": metrics["paper_p50"],
        "ink_p50": metrics["ink_p50"],
        "mask_ratio": metrics["mask_ratio"],
        "angle_deg": round(float(geometry.angle), 2),
        "outside_ratio": round(float(geometry.outside_ratio), 4),
        "review": metrics["review"],
        "scale": result.scale,
        "stroke_width": round(result.stroke_width, 2),
        "t_high": round(result.t_high, 3),
        "t_low": round(result.t_low, 3),
        "stain": result.info or {},
        "ink_params": asdict(params),
    }
    return image, meta


def run_page(path: Path, preset_name: str = "auto") -> tuple[np.ndarray, dict]:
    started = time.perf_counter()
    source = imread(path)
    src_h, src_w = source.shape[:2]
    if preset_name == "auto":
        tier, features = classify(source)
        feature_dict = features.to_dict()
    elif preset_name in PRESETS:
        tier = preset_name
        feature_dict = {}
    else:
        raise ValueError(f"未知预设: {preset_name}")

    preset = PRESETS[tier]
    png, page_meta = process_page(source, tier, InkParams(stain=preset.stain_strength + 0.15), preset.crop_text_block)
    out_h, out_w = png.shape
    meta = {
        "source": path.name,
        "tier": tier,
        "size_in": [int(src_w), int(src_h)],
        "size_out": [int(out_w), int(out_h)],
        **page_meta,
        "ms": int((time.perf_counter() - started) * 1000),
        "features": feature_dict,
    }
    return png, meta
