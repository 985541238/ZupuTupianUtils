"""把分档、拉正、纸色、掩膜、合成和验收串成一页。"""

import time
from pathlib import Path

import cv2
import numpy as np

from scanwash.classify import classify
from scanwash.composite import apply_gutter, composite, refine_thin_strokes
from scanwash.geometry import correct, crop_text_block
from scanwash.mask import build_mask
from scanwash.paper import normalize
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
    geometry = correct(source, tier)
    gray = normalize(geometry.gray, preset)
    ink = build_mask(gray, preset)
    warnings = list(geometry.warnings)

    if preset.crop_text_block:
        gray, cropped, loss = crop_text_block(gray, ink.mask, ink.stroke)
        ink.mask = cropped
        if loss:
            warnings.append("text_loss_risk")

    image, alpha = composite(gray, ink.mask, ink.cut, preset.sharpen)
    gutter = False
    if preset.keep_gutter:
        image, gutter = apply_gutter(image, alpha, ink.peaks, ink.spacing)

    metrics = evaluate(image, ink.mask, alpha, tier, warnings)
    png = np.clip(np.rint(image), 0, 255).astype(np.uint8)
    png = refine_thin_strokes(png)
    out_h, out_w = png.shape
    meta = {
        "source": path.name,
        "tier": tier,
        "warnings": warnings,
        "size_in": [int(src_w), int(src_h)],
        "size_out": [int(out_w), int(out_h)],
        "paper_p50": metrics["paper_p50"],
        "ink_p50": metrics["ink_p50"],
        "mask_ratio": metrics["mask_ratio"],
        "angle_deg": round(float(geometry.angle), 2),
        "gutter": gutter,
        "outside_ratio": round(float(geometry.outside_ratio), 4),
        "review": metrics["review"],
        "ms": int((time.perf_counter() - started) * 1000),
        "preset": preset.to_dict(),
        "features": feature_dict,
    }
    return png, meta
