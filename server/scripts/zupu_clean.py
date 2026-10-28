# -*- coding: utf-8 -*-
"""Nest 入口：ScanWash + 审阅页滑块覆盖参数。"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2
import numpy as np

from scanwash.classify import classify
from scanwash.inkrender import InkParams
from scanwash.pipeline import imread, imwrite_gray, process_page
from scanwash.presets import PRESETS


def map_overrides(threshold: float, denoise: float, contrast: float, stain: float | None = None) -> InkParams:
    """审阅页滑块 → 墨迹提取参数。推荐档（threshold 60% / denoise 55% / sharpen 35% / stain 40%）
    落在各参数的中点 0.5 附近，两端拉开，拖动时差异明显。

    - 油墨阈值：越往左越敏感（多留淡墨细笔），越往右越干净（只留浓墨）
    - 去噪：最小连通域与淡污渍块剔除力度
    - 锐度：墨色映射陡峭程度
    - 去渍：彩色（黄/褐/霉）污渍抑制比例
    """

    def through_mid(x: float, x_mid: float, y0: float, y_mid: float, y1: float) -> float:
        x = float(np.clip(x, 0.0, 1.0))
        if x <= x_mid:
            t = (x / x_mid) if x_mid > 0 else 0.0
            return y0 + t * (y_mid - y0)
        t = ((x - x_mid) / (1.0 - x_mid)) if x_mid < 1.0 else 1.0
        return y_mid + t * (y1 - y_mid)

    t_norm = (float(np.clip(threshold, 60, 240)) - 60.0) / 180.0
    d_norm = float(np.clip(denoise, 0, 16)) / 16.0
    c_norm = (float(np.clip(contrast, 0.4, 3.6)) - 0.4) / 3.2
    s = 0.4 if stain is None else float(np.clip(stain, 0.0, 1.0))
    return InkParams(
        sensitivity=through_mid(t_norm, 0.60, 0.95, 0.5, 0.2),
        denoise=through_mid(d_norm, 0.55, 0.0, 0.5, 1.0),
        sharpen=through_mid(c_norm, 0.35, 0.0, 0.5, 1.0),
        stain=through_mid(s, 0.40, 0.0, 0.55, 1.0),
    )


def run_page_overridden(
    path: Path,
    preset_name: str,
    threshold: float,
    denoise: float,
    contrast: float,
    auto_crop: bool,
    stain: float | None = None,
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

    params = map_overrides(threshold, denoise, contrast, stain=stain)
    png, page_meta = process_page(source, tier, params, auto_crop)
    out_h, out_w = png.shape
    meta = {
        "tier": tier,
        "size_in": [int(src_w), int(src_h)],
        "size_out": [int(out_w), int(out_h)],
        **page_meta,
        "ms": int((time.perf_counter() - started) * 1000),
        "features": feature_dict,
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
    # Destain 0~1 (UI 0~100% → Nest stain → here). Default mild ~0.40.
    p.add_argument("--stain", type=float, default=0.4)
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
            stain=float(args.stain),
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
