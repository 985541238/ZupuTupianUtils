"""scanwash Web 服务：上传扫描页 -> 清洗 -> 返回白纸黑字 PNG。

接口：
- POST /api/clean  multipart 上传 + preset(auto/clean/aged/damaged)，返回 PNG，
                    元数据放在 X-Scanwash-Meta 响应头（JSON）
- GET  /api/health 健康检查
- GET  /           简易上传页面
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Query, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from scanwash.pipeline import imwrite_gray, run_page

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
ALLOWED_SUFFIX = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"}

app = FastAPI(title="scanwash", version="1.0.0")

STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "scanwash", "version": "1.0.0"}


@app.post("/api/clean")
async def clean(file: UploadFile = File(...), preset: str = Query("auto")) -> Response:
    if preset not in {"auto", "clean", "aged", "damaged"}:
        return JSONResponse({"error": "unknown preset: " + preset}, status_code=400)
    data = await file.read()
    if not data:
        return JSONResponse({"error": "empty file"}, status_code=400)
    if len(data) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "file too large (max 40MB)"}, status_code=413)
    suffix = Path(file.filename or "upload.jpg").suffix.lower()
    if suffix not in ALLOWED_SUFFIX:
        return JSONResponse({"error": "unsupported format: " + suffix}, status_code=415)

    with tempfile.TemporaryDirectory(prefix="scanwash-") as tmp:
        src = Path(tmp) / ("src" + suffix)
        src.write_bytes(data)
        try:
            image, meta = run_page(src, preset)
        except Exception as exc:  # 单张失败不影响服务
            return JSONResponse({"error": "clean failed: " + str(exc)}, status_code=422)
        out = Path(tmp) / "out.png"
        imwrite_gray(out, image)
        png = out.read_bytes()

    # 响应头只放 ASCII（ensure_ascii 默认转义中文），避免头编码问题
    headers = {"X-Scanwash-Meta": json.dumps(meta)}
    return Response(content=png, media_type="image/png", headers=headers)


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    page = STATIC_DIR / "index.html"
    return HTMLResponse(page.read_text(encoding="utf-8"))
