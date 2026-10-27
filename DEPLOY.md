# 部署说明（速查）

更细的步骤在 `docs/deploy-online/`（step / mysql / redis / nginx / pm2）。这里只记**本框架**约定，方便上 Git 后别人照做。

## 产物分别是什么

| 端 | 打包命令（仓库根） | 产物目录 | 线上怎么跑 |
|----|-------------------|----------|------------|
| 服务端 | `npm run build:server:prod` | `server/dist` | Node + **PM2**（参考 `server/ecosystem.config.cjs`） |
| 管理端 React | `npm run build:admin:prod` | `admin-web/dist` | **Nginx** 静态目录 + `try_files` |
| 客户端 uniapp | HBuilderX 发行 | 各端发行包 | 微信后台 / 应用商店 / H5 静态 |

测试环境把上面的 `prod` 换成 `test` / `stage`（见 `BUILD.md`）。

## 部署前必改配置（不要把真实密码提交到 Git）

1. **`sql/`** — 服务器建库后导入 `init.sql`（或 mysql56 版）  
2. **`server/src/config/prod.yml`** — 数据库、Redis、JWT、`app.file.domain` 等  
3. **`admin-web/.env.production`** — `VITE_APP_BASE_API`（如 `/prod-api`）  
4. Nginx — 静态指向 `admin-web/dist`，并把 `/prod-api` 反代到 Nest 端口（默认 8080）

> 当前 `.gitignore` 会忽略 `prod.yml` / `test.yml`，避免密钥进库。请在服务器或私密渠道单独放置，或提交 `*.yml.example` 再本地复制。

## 推荐部署顺序

1. MySQL + Redis 就绪，导入 `sql/`  
2. 上传并安装依赖，启动 Nest（PM2）  
3. 配置 Nginx 反代 API  
4. 上传管理端 `dist`  
5. （可选）发行 uni-app 客户端，API 指向同一后端  

细则：`docs/deploy-online/step.md`。

## PM2 备注

- 配置文件：`server/ecosystem.config.cjs`  
- 上线前按服务器路径改 `cwd`、日志目录、`user`  
- 示例：`pm2 start ecosystem.config.cjs` 后 `pm2 save`  

## Nginx 备注

- 管理端：`root` 指向前端 `dist`，`location /` 使用 `try_files $uri $uri/ /index.html;`  
- 接口：例如 `location /prod-api/ { proxy_pass http://127.0.0.1:8080/; ... }`  
- 上传/静态文件：若文件域名走后端，注意 `client_max_body_size`  

完整示例见 `docs/deploy-online/nginx.md`。

## uni-app 客户端

- 源码在 `uniapp/`，**不要**提交 `unpackage/`  
- 发行前改接口 baseURL 为线上 API  
- 与管理端共用同一套 `server` 时，注意鉴权与权限菜单是否对 C 端开放

