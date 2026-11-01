"""按当前清洗流程重做对比图：左原图，右修复结果。用完即删。"""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from scanwash.pipeline import imread, run_page

ROOT = Path(r"D:\系统默认\文档\修图测试效果")
OUT = ROOT / "对比图"
HEIGHT = 2000
BAR = 72
GAP = 16
FONT = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 36)


def fit(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    scale = HEIGHT / height
    new_width = max(1, int(round(width * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4
    return cv2.resize(image, (new_width, HEIGHT), interpolation=interpolation)


def panel(image: np.ndarray, label: str) -> np.ndarray:
    body = fit(image)
    if body.ndim == 2:
        body = cv2.cvtColor(body, cv2.COLOR_GRAY2BGR)
    bar = np.full((BAR, body.shape[1], 3), 255, np.uint8)
    draw = ImageDraw.Draw(Image.fromarray(cv2.cvtColor(bar, cv2.COLOR_BGR2RGB)))
    box = draw.textbbox((0, 0), label, font=FONT)
    x = (body.shape[1] - (box[2] - box[0])) // 2
    y = (BAR - (box[3] - box[1])) // 2 - box[1]
    draw.text((x, y), label, fill=(20, 20, 20), font=FONT)
    bar = cv2.cvtColor(np.array(draw._image), cv2.COLOR_RGB2BGR) if False else None
    painted = Image.fromarray(cv2.cvtColor(np.full((BAR, body.shape[1], 3), 255, np.uint8), cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(painted)
    box = draw.textbbox((0, 0), label, font=FONT)
    x = (body.shape[1] - (box[2] - box[0])) // 2
    y = (BAR - (box[3] - box[1])) // 2 - box[1]
    draw.text((x, y), label, fill=(20, 20, 20), font=FONT)
    header = cv2.cvtColor(np.array(painted), cv2.COLOR_RGB2BGR)
    return np.vstack([header, body])


def main() -> None:
    OUT.mkdir(exist_ok=True)
    sources = sorted(ROOT.glob("*.jpg"))
    for path in sources:
        source = imread(path)
        restored, meta = run_page(path)
        left = panel(source, "原图")
        right = panel(restored, "修复后")
        gap = np.full((left.shape[0], GAP, 3), 255, np.uint8)
        sheet = np.hstack([left, gap, right])
        ok, encoded = cv2.imencode(".jpg", sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            raise RuntimeError(path.name)
        target = OUT / f"{path.stem}_对比.jpg"
        encoded.tofile(str(target))
        print(path.name, meta["size_in"], "->", meta["size_out"], sheet.shape[1], "x", sheet.shape[0], meta["ms"], "ms")


if __name__ == "__main__":
    main()
