# -*- coding: utf-8 -*-
"""Nest 入口：ScanWash + 审阅页滑块覆盖参数。"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2
import numpy as np

from scanwash.classify import classify
from scanwash.composite import apply_gutter, composite, refine_thin_strokes
from scanwash.geometry import correct, crop_text_block
from scanwash.mask import build_mask
from scanwash.paper import normalize
from scanwash.pipeline import imread, imwrite_gray
from scanwash.presets import PRESETS
from scanwash.qa import evaluate


def map_overrides(base, threshold: float, denoise: float, contrast: float, auto_crop: bool):
    """审阅页三滑块 → ScanWash Preset。

    UI 推荐档（约 denoise 55% / threshold 60% / sharpen 35%）仍落在族谱复印常用区间；
    两端故意拉得很开，拖动时预览差异明显。
    """

    def through_mid(x: float, x_mid: float, y0: float, y_mid: float, y1: float) -> float:
        x = float(np.clip(x, 0.0, 1.0))
        if x <= x_mid:
            t = (x / x_mid) if x_mid > 0 else 0.0
            return y0 + t * (y_mid - y0)
        t = ((x - x_mid) / (1.0 - x_mid)) if x_mid < 1.0 else 1.0
        return y_mid + t * (y1 - y_mid)

    # Nest spans (matches admin-web uiToNestParams): threshold 60–240, denoise 0–16, contrast 0.4–3.6
    t = float(np.clip(threshold, 60, 240))
    t_norm = (t - 60.0) / 180.0  # UI 0–100; recommended 60% → 0.60

    # 油墨阈值：左淡墨多留灰 → 右高黑二值。推荐 60% → keep_dark≈55（近 aged）
    keep_dark = through_mid(t_norm, 0.60, 98.0, 55.0, 10.0)
    bh = through_mid(t_norm, 0.60, 82.0, 96.0, 99.0)

    d = float(np.clip(denoise, 0, 16))
    d_norm = d / 16.0  # recommended 55% → 0.55
    # 去渍：左几乎不动纸面 → 右强闭运算+高 k。推荐 → close≈0.055 / k≈0.19
    close_frac = through_mid(d_norm, 0.55, 0.004, 0.055, 0.22)
    sauvola_k = through_mid(d_norm, 0.55, 0.05, 0.19, 0.45)

    c = float(np.clip(contrast, 0.4, 3.6))
    c_norm = (c - 0.4) / 3.2  # recommended 35% → 0.35
    # 锐度：左近原迹 → 右高锐利。推荐 → sharpen≈0.60（近 clean）
    sharpen = through_mid(c_norm, 0.35, 0.0, 0.60, 2.4)

    return replace(
        base,
        keep_dark_pct=float(np.clip(keep_dark, 8, 99)),
        close_frac=float(np.clip(close_frac, 0.003, 0.25)),
        sharpen=float(np.clip(sharpen, 0.0, 2.5)),
        sauvola_k=float(np.clip(sauvola_k, 0.04, 0.48)),
        bh_percentile=float(np.clip(bh, 80.0, 99.5)),
        crop_text_block=bool(auto_crop),
    )


def run_page_overridden(
    path: Path,
    preset_name: str,
    threshold: float,
    denoise: float,
    contrast: float,
    auto_crop: bool,
):
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

    preset = map_overrides(PRESETS[tier], threshold, denoise, contrast, auto_crop)
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
        "tier": tier,
        "warnings": warnings,
        "size_in": [int(src_w), int(src_h)],
        "size_out": [int(out_w), int(out_h)],
        "paper_p50": metrics["paper_p50"],
        "ink_p50": metrics["ink_p50"],
        "mask_ratio": metrics["mask_ratio"],
        "angle_deg": round(float(geometry.angle), 2),
        "gutter": gutter,
        "review": metrics["review"],
        "ms": int((time.perf_counter() - started) * 1000),
        "features": feature_dict,
        "overrides": {
            "keep_dark_pct": preset.keep_dark_pct,
            "close_frac": preset.close_frac,
            "sharpen": preset.sharpen,
            "sauvola_k": preset.sauvola_k,
            "crop_text_block": preset.crop_text_block,
        },
    }
    return png, meta


def _imread_bgr(path: Path):
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法读取输入图: {path}")
    return img


def _imwrite_bgr(path: Path, img) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("imencode failed")
    buf.tofile(str(path))


def crop_source_first(inp: Path, crop_csv: str) -> Path:
    """Crop original BEFORE ScanWash so recognition runs only on the selection."""
    x, y, w, h = [int(float(v)) for v in crop_csv.split(",")]
    src = _imread_bgr(inp)
    sh, sw = src.shape[:2]
    x = max(0, min(sw - 1, x))
    y = max(0, min(sh - 1, y))
    w = max(1, min(sw - x, w))
    h = max(1, min(sh - y, h))
    cropped = src[y : y + h, x : x + w]
    fd, name = tempfile.mkstemp(prefix="zupu-crop-", suffix=".png")
    os.close(fd)
    out = Path(name)
    _imwrite_bgr(out, cropped)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--preset", default="auto", choices=["auto", "clean", "aged", "damaged"])
    p.add_argument("--method", default="relative")
    p.add_argument("--threshold", type=float, default=176)
    p.add_argument("--denoise", type=float, default=6)
    p.add_argument("--contrast", type=float, default=1.2)
    p.add_argument("--min-area", type=float, default=35)
    # Product: full page unless Nest already carved a manual cropBox. Default OFF.
    p.add_argument("--auto-crop", type=int, default=0)
    p.add_argument("--crop-padding", type=int, default=16)
    p.add_argument("--crop", default="")
    args = p.parse_args()

    tmp_crop: Path | None = None
    try:
        work_in = Path(args.inp)
        manual_crop = bool(args.crop and args.crop.strip())
        if manual_crop:
            # Authoritative: crop original region first; disable ScanWash auto crop.
            tmp_crop = crop_source_first(work_in, args.crop.strip())
            work_in = tmp_crop

        # ScanWash crop_text_block only when --auto-crop=1 (Nest always sends 0).
        image, meta = run_page_overridden(
            work_in,
            args.preset,
            args.threshold,
            args.denoise,
            args.contrast,
            bool(args.auto_crop) and not manual_crop,
        )

        if manual_crop:
            meta = dict(meta)
            meta["manual_crop"] = args.crop.strip()
            meta["crop_applied_before"] = True

        imwrite_gray(Path(args.out), image)
        hh, ww = image.shape[:2]
        print(
            json.dumps(
                {"ok": True, "width": ww, "height": hh, "meta": meta},
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 2
    finally:
        if tmp_crop is not None:
            try:
                tmp_crop.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
