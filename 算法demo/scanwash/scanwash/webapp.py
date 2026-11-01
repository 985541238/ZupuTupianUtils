"""本地网页：上传一页扫描图，查看修复结果。

启动：python -m scanwash.webapp
"""

import argparse
import base64
import json
import os
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2

from scanwash.pipeline import run_page
from scanwash.presets import PRESETS

PAGE = Path(__file__).with_name("page.html")
MAX_BYTES = 40 * 1024 * 1024
PROCESS_LOCK = threading.Lock()


class App(BaseHTTPRequestHandler):
    server_version = "scanwash/1.0"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = PAGE.read_bytes()
            self._send(200, "text/html; charset=utf-8", body)
            return
        if path == "/favicon.ico":
            self._send(204, "image/x-icon", b"")
            return
        self._send(404, "text/plain; charset=utf-8", "未找到".encode())

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/process":
            self._send(404, "application/json; charset=utf-8", _json({"error": "未找到"}))
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BYTES:
            self._send(400, "application/json; charset=utf-8", _json({"error": "图片为空或超过 40MB"}))
            return
        preset = parse_qs(parsed.query).get("preset", ["auto"])[0]
        if preset != "auto" and preset not in PRESETS:
            self._send(400, "application/json; charset=utf-8", _json({"error": "未知分档"}))
            return
        if not PROCESS_LOCK.acquire(blocking=False):
            self._send(429, "application/json; charset=utf-8", _json({"error": "正在处理另一张，请稍后再试"}))
            return
        handle = None
        path = None
        try:
            payload = self.rfile.read(length)
            handle, path = tempfile.mkstemp(suffix=".img")
            os.write(handle, payload)
            os.close(handle)
            handle = None
            image, meta = run_page(Path(path), preset)
            ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            if not ok:
                raise RuntimeError("结果编码失败")
            body = {
                "tier": meta["tier"],
                "warnings": meta["warnings"],
                "paper_p50": meta["paper_p50"],
                "ink_p50": meta["ink_p50"],
                "mask_ratio": meta["mask_ratio"],
                "ms": meta["ms"],
                "size_out": meta["size_out"],
                "image": base64.b64encode(encoded.tobytes()).decode("ascii"),
            }
            self._send(200, "application/json; charset=utf-8", _json(body))
        except Exception as exc:
            self._send(400, "application/json; charset=utf-8", _json({"error": str(exc)}))
        finally:
            if handle is not None:
                os.close(handle)
            if path and os.path.exists(path):
                os.remove(path)
            PROCESS_LOCK.release()

    def log_message(self, fmt: str, *args) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _json(data: dict) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="打开族谱页清洗的本地网页")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), App)
    url = f"http://{args.host}:{args.port}"
    print(f"族谱页清洗已启动：{url}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
