# -*- coding: utf-8 -*-
"""透视修正（纯本地 OpenCV，不调用任何模型）。

detect: 自动找出页面/文字区域的四个角（归一化 0~1，顺序 左上 右上 右下 左下）
warp:   按四个角把斜着拍的页面拉正成矩形
"""
from __future__ import annotations

import argparse
import json
import sys

import cv2
import numpy as np


def imread(path: str) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("无法读取图片")
    return img


def imwrite_png(path: str, img: np.ndarray) -> None:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("无法保存图片")
    buf.tofile(path)


def order_quad(pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(axis=1)
    d = (pts[:, 0] - pts[:, 1])
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmax(d)]
    bl = pts[np.argmin(d)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def detect_paper(gray: np.ndarray) -> np.ndarray | None:
    """拍照/扫描时纸张和背景有明显反差：找最大的四边形轮廓。"""
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (7, 7), 0)
    best = None
    best_area = 0.0
    for mode in ("otsu", "otsu_inv", "canny"):
        if mode == "canny":
            edges = cv2.Canny(blur, 40, 120)
            m = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
        else:
            _, m = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU if mode == "otsu_inv" else cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:3]:
            area = cv2.contourArea(c)
            if area < 0.3 * w * h or area > 0.985 * w * h:
                continue
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            approx = cv2.approxPolyDP(hull, 0.02 * peri, True)
            if len(approx) == 4 and area > best_area:
                best, best_area = approx.reshape(4, 2), area
    return best


def detect_text_block(gray: np.ndarray) -> np.ndarray | None:
    """没有明显纸边时：按文字（墨迹）整体的最小外接旋转矩形来定，能把整体歪斜拉正。"""
    h, w = gray.shape
    th = cv2.adaptiveThreshold(cv2.GaussianBlur(gray, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(th, 8)
    keep = np.zeros_like(th)
    for i in range(1, n):
        x, y, cw, ch, a = stats[i]
        # 去掉太小的噪点和贴边的长条（边框、阴影）
        if a < 12 or a > 0.02 * w * h:
            continue
        if (cw > 0.5 * w and ch < 0.02 * h) or (ch > 0.5 * h and cw < 0.02 * w):
            continue
        keep[lab == i] = 255
    ys, xs = np.nonzero(keep)
    if len(xs) < 200:
        return None
    # 去掉最外侧 1% 的离群点，避免个别污点把框撑大
    lo_x, hi_x = np.percentile(xs, [0.5, 99.5])
    lo_y, hi_y = np.percentile(ys, [0.5, 99.5])
    sel = (xs >= lo_x) & (xs <= hi_x) & (ys >= lo_y) & (ys <= hi_y)
    pts = np.stack([xs[sel], ys[sel]], axis=1).astype(np.float32)
    rect = cv2.minAreaRect(pts)
    box = cv2.boxPoints(rect)
    # 四周留一点边
    c = box.mean(axis=0)
    box = c + (box - c) * 1.03
    return box


def cmd_detect(a) -> dict:
    img = imread(a.inp)
    H, W = img.shape[:2]
    s = min(1.0, 1200.0 / max(H, W))
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    sh, sw = gray.shape
    quad = detect_paper(gray)
    method = "paper"
    if quad is None:
        quad = detect_text_block(gray)
        method = "text"
    if quad is None:
        return {"ok": True, "found": False}
    q = order_quad(quad)
    q[:, 0] = np.clip(q[:, 0] / sw, 0, 1)
    q[:, 1] = np.clip(q[:, 1] / sh, 0, 1)
    return {"ok": True, "found": True, "method": method, "quad": q.round(5).tolist()}


def cmd_warp(a) -> dict:
    img = imread(a.inp)
    H, W = img.shape[:2]
    q = np.array([[float(v) for v in p.split(",")] for p in a.quad.split(";")], dtype=np.float32)
    if q.shape != (4, 2):
        raise RuntimeError("需要四个点")
    q[:, 0] *= W
    q[:, 1] *= H
    q = order_quad(q)
    tl, tr, br, bl = q
    ow = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    oh = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    if ow < 50 or oh < 50:
        raise RuntimeError("选的四个点范围太小")
    # 面积太小/点太挤（比如三点共线）会算出畸形图
    def cross(u, v):
        return float(u[0] * v[1] - u[1] * v[0])

    area = 0.5 * abs(cross(tr - tl, bl - tl)) + 0.5 * abs(cross(br - tr, br - bl))
    if area < 0.02 * W * H:
        raise RuntimeError("选的四个点围出的范围太小，请重新选")
    m = max(ow, oh)
    if m > 8000:
        k = 8000.0 / m
        ow, oh = int(ow * k), int(oh * k)
    dst = np.array([[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(q, dst)
    out = cv2.warpPerspective(img, M, (ow, oh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    imwrite_png(a.out, out)
    return {"ok": True, "width": ow, "height": oh}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["detect", "warp"])
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", default="")
    p.add_argument("--quad", default="")
    a = p.parse_args()
    try:
        r = cmd_detect(a) if a.cmd == "detect" else cmd_warp(a)
    except Exception as e:  # noqa: BLE001
        r = {"ok": False, "error": str(e)}
    sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
