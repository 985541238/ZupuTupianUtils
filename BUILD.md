# 本地运行 vs 打包

更完整的目录说明见 [STRUCTURE.md](./STRUCTURE.md)，部署见 [DEPLOY.md](./DEPLOY.md)，初始库见 [sql/README.md](./sql/README.md)。

## 本地（无需打包，直接跑）

准备：MySQL + Redis，并已导入 `sql/` 脚本。

根目录：

- 后端：`npm run dev:server`
- 前端（React 管理端（圆形原型））：`npm run dev:admin`

或在 **WebStorm 2026.1** 使用运行配置 `start_server` / `start_admin_vue3`。

本地接口走开发代理（如 `/dev-api` -> `http://localhost:8080`）。

## 打包（仅生产 / 测试）

| 环境 | 根目录命令 | 前端配置 | 后端配置 | 地址 |
|------|------------|----------|----------|------|
| 生产包 | `npm run build:prod` | `admin-web/.env.production` | `server/src/config/prod.yml` | 按服务器填写 |
| 测试包 | `npm run build:test` | `admin-web/.env.staging` | `server/src/config/test.yml` | 按服务器填写 |

部署前把地址填进对应文件：

- 前端：`VITE_APP_BASE_API`
- 后端：`app.file.domain`（以及数据库、Redis、JWT 等）

## 产物

- 前端：`admin-web/dist` → Nginx 静态
- 后端：`server/dist` → PM2（`server/ecosystem.config.cjs`）
