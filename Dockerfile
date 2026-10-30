# ============================================================
# 族谱扫描清理工具（ZupuTupianUtils）单容器镜像
#
# 一个容器同时提供：
#   - NestJS 后端 API（端口 8080）
#   - admin-web 前端静态页（由后端同端口托管，接口前缀 /dev-api）
#   - Python OpenCV 图像流水线（server/scripts/*.py）
#
# 为什么不用 node:20-slim 做底座：
#   本机到 Docker Hub / deb.debian.org 均不通，apt 装不了 Python。
#   故用 python:3.12-slim（Debian 13 / glibc 2.41）做底座，
#   Node 用官方二进制从国内镜像解包，Python 依赖走清华 PyPI，
#   全程不依赖 apt。
#
# 构建：
#   docker build --platform linux/amd64 -t zupu-scan:v1.0.0 .
# ============================================================

ARG PY_IMAGE=python:3.12-slim

# ---------- Node 运行时（国内镜像解包官方二进制，不碰 apt / Docker Hub） ----------
FROM ${PY_IMAGE} AS node
ARG NODE_VERSION=20.19.0
ARG NODE_MIRROR=https://registry.npmmirror.com/-/binary/node
# npm 的 shebang 是 `#!/usr/bin/env node`，必须先让 node 进 PATH
ENV PATH=/opt/node/bin:$PATH
RUN set -eux; \
    python -c "import urllib.request; urllib.request.urlretrieve('${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz','/tmp/node.tar.gz')"; \
    mkdir -p /opt/node; \
    tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1; \
    rm -f /tmp/node.tar.gz; \
    /opt/node/bin/node -v; \
    /opt/node/bin/npm -v

# ---------- 前端 + 后端编译 ----------
FROM node AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PATH=/opt/node/bin:$PATH
WORKDIR /app

# 先只拷 package.json，让依赖层可缓存
COPY admin-web/package.json admin-web/package-lock.json ./admin-web/
COPY server/package.json server/package-lock.json ./server/
RUN set -eux; \
    cd admin-web && npm ci --registry=${NPM_REGISTRY} --no-audit --no-fund; \
    cd ../server && npm ci --registry=${NPM_REGISTRY} --no-audit --no-fund

COPY admin-web ./admin-web
COPY server ./server
RUN set -eux; \
    cd server && npm run build:prod; \
    cd ../admin-web && npm run build; \
    test -f /app/server/dist/main.js; \
    test -f /app/admin-web/dist/index.html

# ---------- 生产依赖（不含 devDependencies，控制体积） ----------
FROM node AS proddeps
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PATH=/opt/node/bin:$PATH
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --registry=${NPM_REGISTRY} --no-audit --no-fund

# ---------- 运行时 ----------
FROM node AS runtime

# OpenCV headless：不含 GUI/X11 依赖，可直接在 slim 上跑
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir --index-url ${PIP_INDEX} \
        numpy==1.26.4 \
        opencv-python-headless==4.10.0.84 \
    && python -c "import cv2, numpy; print('cv2', cv2.__version__, 'numpy', numpy.__version__)"

ENV PATH=/opt/node/bin:$PATH \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    NODE_ENV=production \
    PORT=8080 \
    ADMIN_DIST=/app/admin-web/dist \
    OUTPUT_ROOT=/app/data/output \
    UPLOAD_ROOT=/app/data/uploads

WORKDIR /app
COPY --from=proddeps /app/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY server/scripts ./server/scripts
COPY --from=build /app/admin-web/dist ./admin-web/dist

# 非 root 运行；数据目录（上传/输出）用卷挂载
RUN set -eux; \
    useradd --system --uid 1000 --create-home --shell /usr/sbin/nologin app; \
    mkdir -p /app/data/output /app/data/uploads; \
    chown -R app:app /app/data; \
    chmod -R a+rX /app/server /app/admin-web

USER app
# 工作目录必须是 server：代码里用 cwd/../data 推导数据目录
WORKDIR /app/server

EXPOSE 8080

# 健康检查：GET / 命中后端托管的前端首页（200 即就绪）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
