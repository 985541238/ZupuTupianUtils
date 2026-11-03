"""把分档、拉正、纸色、掩膜、合成和验收串成一页（算法 demo 版）。

- 纸色归一化 → 黑帽/Sauvola 掩膜 → 合成白纸黑字 → 书缝阴影 → 细笔收边
- 审阅页四个滑块通过 presets.Preset 的 keep_dark_pct / bh_percentile / sharpen / denoise / stain 覆盖
- 去渍（stain）在转灰前抑制黄褐色污渍
- 内存保护：超大图缩小处理，成品统一缩回原尺寸（与审阅/OCR 对位一致）
"""

import os
import time
from pathlib import Path

import cv2
import numpy as np

from scanwash.classify import classify
from scanwash.composite import apply_gutter, composite, refine_thin_strokes
from scanwash.geometry import correct, crop_text_block
from scanwash.mask import build_mask
from scanwash.paper import normalize
from scanwash.presets import PRESETS, Preset
from scanwash.qa import evaluate


def imread(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"无法读取图片: {Path(path).name}")
    return image


def imwrite_gray(path: Path, gray: np.ndarray) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(".png", gray)
    if not ok:
        raise RuntimeError(f"无法编码: {path.name}")
    encoded.tofile(str(path))


def _destain_gray(bgr: np.ndarray, stain: float, strong_destain: bool = False) -> np.ndarray:
    """转灰并抑制黄/褐/红污渍：墨是中性色（R≈B），污渍偏暖（R高B低）。
    stain 越大，偏暖处越往白推；中性墨不受影响。返回 uint8 灰度。"""
    b, g, r = cv2.split(bgr.astype(np.float32))
    gray = 0.299 * r + 0.587 * g + 0.114 * b
    s = float(np.clip(stain, 0.0, 1.0))
    if s > 0:
        warm = np.clip(r - b, 0.0, 255.0)  # 黄/褐/红：R 明显高于 B
        gray = gray + s * 1.3 * warm
    if strong_destain:
        # 强力模式处理大片黑斑/脏底：抬高低频背景，保留局部文字对比，
        # 后续 Sauvola 和连通域继续负责保字与过滤孤立噪点。
        # 先轻度平滑高频脏点，避免把黑色颗粒作为文字证据带入成品。
        smooth = cv2.GaussianBlur(gray, (0, 0), 0.85)
        background = cv2.GaussianBlur(smooth, (0, 0), 18.0)
        lift = np.clip(250.0 - background, 0.0, 140.0) * 1.12
        gray = smooth + lift
    return np.clip(gray, 0, 255).astype(np.uint8)


def process_page(
    source: np.ndarray,
    tier: str,
    preset: Preset,
    auto_crop: bool = False,
) -> tuple[np.ndarray, dict]:
    """一页：拉正 → 去渍转灰 → 纸色归一 → 掩膜 → 合成 → 书缝 → 细笔收边。
    成品尺寸等于输入尺寸（内部若缩小处理，最后缩回）。"""
    in_h, in_w = source.shape[:2]

    # 内存保护：超大图先缩小处理（默认 > 1200 万像素）
    max_px = float(os.environ.get("ZW_MAX_PIXELS", "12000000"))
    work_src = source
    if max_px > 0 and in_h * in_w > max_px:
        f = (max_px / float(in_h * in_w)) ** 0.5
        work_src = cv2.resize(source, (max(1, int(round(in_w * f))), max(1, int(round(in_h * f)))), interpolation=cv2.INTER_AREA)

    geometry = correct(work_src, tier)
    bgr = geometry.bgr if geometry.bgr is not None else cv2.cvtColor(geometry.gray, cv2.COLOR_GRAY2BGR)
    gray_in = _destain_gray(
        bgr,
        getattr(preset, "stain", 0.0),
        bool(getattr(preset, "strong_destain", False)),
    )

    gray = normalize(gray_in, preset)
    ink = build_mask(gray, preset)
    warnings = list(geometry.warnings)

    if preset.crop_text_block and auto_crop:
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
    # 细笔收边较费时（会临时 2 倍放大）。拖动滑块的快速预览可用 ZW_SKIP_REFINE=1 跳过，落盘成品仍走完整流程。
    if not os.environ.get("ZW_SKIP_REFINE"):
        png = refine_thin_strokes(png)

    # 统一缩回输入尺寸（细笔收边可能放大过，内存保护可能缩小过；审阅/OCR 需要与原图同尺寸）
    if png.shape[0] != in_h or png.shape[1] != in_w:
        png = cv2.resize(png, (in_w, in_h), interpolation=cv2.INTER_AREA if png.shape[0] > in_h else cv2.INTER_CUBIC)

    meta = {
        "warnings": warnings,
        "paper_p50": metrics["paper_p50"],
        "ink_p50": metrics["ink_p50"],
        "mask_ratio": metrics["mask_ratio"],
        "angle_deg": round(float(geometry.angle), 2),
        "gutter": gutter,
        "outside_ratio": round(float(geometry.outside_ratio), 4),
        "review": metrics["review"],
        "preset": preset.to_dict(),
    }
    return png, meta


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
    png, page_meta = process_page(source, tier, preset, preset.crop_text_block)
    out_h, out_w = png.shape
    meta = {
        "source": Path(path).name,
        "tier": tier,
        "size_in": [int(src_w), int(src_h)],
        "size_out": [int(out_w), int(out_h)],
        **page_meta,
        "ms": int((time.perf_counter() - started) * 1000),
        "features": feature_dict,
    }
    return png, meta
