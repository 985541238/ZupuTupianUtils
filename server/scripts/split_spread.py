# -*- coding: utf-8 -*-
"""把一张对开的族谱复印图按中缝拆成右、左两页。

族谱竖排、从右往左读，所以右页在前。输出一行 JSON：
{"ok": true, "split": true, "gutter": 1234, "right": {...}, "left": {...}}
找不到可信的中缝时（比如本来就是单页）返回 split=false，调用方按单页处理。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def imread(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法读取图片: {path.name}")
    return img


def imwrite(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("编码失败")
    buf.tofile(str(path))


def find_gutter(bgr: np.ndarray) -> tuple[int | None, str]:
    """在宽度 35%~65% 的范围里找中缝。

    两种中缝都常见：
    - 装订折线：一条贯穿上下的深色竖线（复印时书脊压出的黑线）。
    - 两页版框之间的空白窄带。
    先找贯穿上下的深色竖线，没有再找最亮的空白带。
    """
    h, w = bgr.shape[:2]
    if w < h * 0.9:
        # 竖长图基本是单页
        return None, "portrait"
    scale = min(1.0, 1200.0 / w)
    small = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sh, sw = gray.shape
    y0, y1 = int(sh * 0.08), int(sh * 0.92)
    band = gray[y0:y1]
    lo, hi = int(sw * 0.35), int(sw * 0.65)

    # 竖线：用很高的竖向开运算只留下贯穿上下的长线（书脊线、两页版框的内边线），
    # 文字笔画再长也到不了页高的一半。
    u8 = band.astype(np.uint8)
    ink = cv2.adaptiveThreshold(u8, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 12)
    tall = max(30, int(band.shape[0] * 0.25))
    lines = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, tall)))
    coverage = (lines > 0).mean(axis=0)
    xs = [x for x in range(lo, hi) if coverage[x] >= 0.25]
    if xs:
        # 相邻的列合成一条线，记下每条线的中心
        groups: list[list[int]] = [[xs[0]]]
        for x in xs[1:]:
            if x - groups[-1][-1] <= 2:
                groups[-1].append(x)
            else:
                groups.append([x])
        centers = [sum(g) / len(g) for g in groups]
        mid = sw / 2.0
        near = sorted(centers, key=lambda c: abs(c - mid))
        # 两页内边框常成对出现：取离中心最近、彼此相距不超过 8% 页宽的一对，中缝在两线中间
        best = near[0]
        for c in near[1:]:
            if abs(c - best) <= sw * 0.08:
                best = (best + c) / 2.0
                break
        return int(round(best / scale)), "line"

    # 空白带：列平均亮度最高、且明显比两侧文字区亮
    mean = band.mean(axis=0)
    mean_s = cv2.GaussianBlur(mean.reshape(1, -1), (0, 0), max(2.0, sw / 300)).ravel()
    seg2 = mean_s[lo:hi]
    j = int(np.argmax(seg2))
    text_level = float(np.median(mean_s[int(sw * 0.15):int(sw * 0.85)]))
    if seg2[j] - text_level >= 8:
        return int(round((lo + j) / scale)), "gap"
    return None, "not_found"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--right", required=True)
    p.add_argument("--left", required=True)
    p.add_argument("--gutter", type=int, default=-1, help="手动指定中缝 x，像素")
    args = p.parse_args()
    try:
        img = imread(Path(args.inp))
        h, w = img.shape[:2]
        if args.gutter > 0:
            gx, how = int(min(max(args.gutter, 1), w - 1)), "manual"
        else:
            gx, how = find_gutter(img)
        if gx is None:
            print(json.dumps({"ok": True, "split": False, "reason": how, "width": w, "height": h}))
            return 0
        pad = max(4, int(w * 0.004))
        right = img[:, max(0, gx - pad):]
        left = img[:, : min(w, gx + pad)]
        imwrite(Path(args.right), right)
        imwrite(Path(args.left), left)
        print(json.dumps({
            "ok": True, "split": True, "gutter": gx, "how": how,
            "right": {"width": int(right.shape[1]), "height": h},
            "left": {"width": int(left.shape[1]), "height": h},
        }))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
