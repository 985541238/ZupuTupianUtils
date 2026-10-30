# 宝塔面板（Linux）部署步骤

思路：Node 服务（端口 8081）同时提供接口和管理端页面，宝塔 Nginx 只做反向代理 + https。

## 1. 宝塔里装软件
软件商店安装：**Nginx**、**MySQL 5.6 或更高**、**PM2 管理器**（会带 Node 版本管理，选 Node 20/22）。

## 2. SSH 里装系统依赖
```bash
# Python 与 OpenCV（图片处理、透视修正用）
apt update && apt install -y python3 python3-pip git        # CentOS：yum install -y python3 python3-pip git
pip3 install opencv-python-headless numpy scipy --break-system-packages   # 旧系统去掉 --break-system-packages
```

## 3. 拉代码并构建
```bash
cd /www/wwwroot && git clone https://github.com/985541238/ZupuTupianUtils.git zupu && cd zupu
cd server && npm ci && npm run build:prod && cd ..
cd admin-web && npm ci && npm run build && cd ..
```
（npm 慢可先 `npm config set registry https://registry.npmmirror.com`）

## 4. 建库
宝塔「数据库 → 添加数据库」：库名 `zupu_scan`，用户 `zupu`，字符集 utf8mb4，记下密码。然后：
```bash
cd /www/wwwroot/zupu/sql
mysql -uzupu -p zupu_scan < init.sql
for f in migrate_*.sql; do mysql -uzupu -p zupu_scan < $f; done   # 报“列已存在”可忽略
```

## 5. 配置 server/.env
```bash
cd /www/wwwroot/zupu/server && cp ../deploy/windows/env.example .env && vi .env
```
必改：`DB_USER` `DB_PASS` `DB_NAME`；`JWT_SECRET`、`SETTINGS_SECRET` 换成随机长字符串（`openssl rand -hex 24`）；
`OUTPUT_ROOT` / `UPLOAD_ROOT` 建议指向大容量盘，如 `/www/zupu-data/output`、`/www/zupu-data/uploads`（目录要先 mkdir）。

## 6. 用 PM2 启动
宝塔「PM2 管理器 → 添加项目」：
- 启动文件：`/www/wwwroot/zupu/server/dist/main.js`
- 项目名称：zupu，运行目录：`/www/wwwroot/zupu/server`

或命令行：
```bash
cd /www/wwwroot/zupu/server && pm2 start dist/main.js --name zupu && pm2 save && pm2 startup
```
检查：`curl -I http://127.0.0.1:8081/` 应返回 200。

## 7. 网站与反向代理（含 https）
宝塔「网站 → 添加站点」填域名（纯 IP 访问也可）→ 「设置 → 反向代理 → 添加」：目标 URL `http://127.0.0.1:8081`。
再在「配置文件」的该站点 `server { }` 里加：
```nginx
client_max_body_size 0;          # 图片逐张上传，不限大小
proxy_request_buffering off;
proxy_read_timeout 600s;         # 处理/识别接口耗时较长
proxy_send_timeout 600s;
```
「SSL」里申请 Let's Encrypt 证书并开启强制 https。**浏览器里的“选择目录”必须在 https 下才可用。**

## 8. 放行端口与登录
- 域名/80/443 在云厂商安全组与宝塔「安全」里放行；8081 不用对外开放。
- 打开 `https://你的域名`，初始账号 `admin` / `admin123`，**登录后立即点右上角头像改账号和密码**。
- 「模型配置」里填百度 OCR 与图片处理模型的 Key（存数据库，用 `SETTINGS_SECRET` 加密）。

## 9. 更新
```bash
cd /www/wwwroot/zupu && git pull
cd server && npm ci && npm run build:prod && cd ../admin-web && npm ci && npm run build
pm2 restart zupu
```

## 常见问题
- 图片处理报“缺少 Python OpenCV”：确认 `python3 -c "import cv2,numpy"` 能运行，且 PM2 用的是同一个用户/环境。
- 502：`pm2 logs zupu` 看报错，多半是数据库密码或库没导入。
- 上传大图失败：检查第 7 步的 `client_max_body_size`。
