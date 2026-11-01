# scanwash 族谱扫描页清洗服务
# 构建：docker build --platform linux/amd64 -t ccr.ccs.tencentyun.com/100000659505/scanwash:v1.0.0 .
FROM python:3.12-slim

WORKDIR /app
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 依赖清单先入层，利用构建缓存；headless 版 opencv 不需要系统图形库
COPY requirements-server.txt .
RUN pip install -r requirements-server.txt

COPY scanwash/ ./scanwash/
COPY app.py ./
COPY static/ ./static/

# 应用监听 0.0.0.0:8000（nginx 按容器名反代，不会 502）
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
