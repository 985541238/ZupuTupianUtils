"""命令行：python -m scanwash <文件或目录> -o out/pages"""

import argparse
import json
import shutil
import sys
from pathlib import Path

from scanwash.pipeline import imwrite_gray, run_page

EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"}


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="清洗族谱扫描页：白纸黑字，不改字形")
    parser.add_argument("input", help="一张图片，或放着图片的目录")
    parser.add_argument("-o", "--output", default="out/pages", help="输出目录，默认 out/pages")
    parser.add_argument(
        "--preset",
        default="auto",
        choices=["auto", "clean", "aged", "damaged"],
        help="auto 按页面分档，也可强制某一档",
    )
    args = parser.parse_args(argv)

    source = Path(args.input)
    files = _inputs(source)
    if not files:
        print(f"没有找到图片: {source}")
        return 1

    output = Path(args.output)
    review = output / "review"
    failed = 0
    for path in files:
        try:
            image, meta = run_page(path, args.preset)
        except Exception as exc:
            failed += 1
            print(f"{path.name}  ERROR  {exc}")
            continue
        destination = output / f"{path.stem}.png"
        imwrite_gray(destination, image)
        (output / f"{path.stem}.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        if meta["review"]:
            review.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(destination, review / destination.name)
        flag = "review" if meta["review"] else "ok"
        warning = ",".join(meta["warnings"]) if meta["warnings"] else "-"
        print(
            f"{path.name}  {meta['tier']:8}  {meta['ms']:5}ms  "
            f"mask {meta['mask_ratio']:.3f}  ink {meta['ink_p50']:.0f}  "
            f"paper {meta['paper_p50']:.0f}  {flag}  {warning}"
        )
    print(f"完成 {len(files) - failed} 张，失败 {failed} 张，输出 {output}")
    return 1 if failed else 0


def _inputs(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if not path.is_dir():
        return []
    return sorted((item for item in path.iterdir() if item.suffix.lower() in EXTS), key=lambda item: item.name)


if __name__ == "__main__":
    raise SystemExit(main())
