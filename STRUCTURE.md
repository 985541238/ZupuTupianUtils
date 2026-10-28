# 框架结构说明

> IDE：推荐 **WebStorm 2026.1**（本仓库已带 `.idea` 运行配置）。也可用 VS Code。

本仓库是 NestJS 管理后台脚手架，包含服务端、两套管理端、一套 uni-app 客户端。

## 目录总览

```
nest-admin-框架/
├── server/           # 服务端（NestJS + TypeORM）—— 业务 API
├── admin-web/       # 管理端（React + Vite + Tailwind）—— 推荐主用
├── uniapp/           # 客户端（uni-app）—— H5 / 小程序 / App
├── sql/              # 本地与部署用的初始数据库脚本（见 sql/README.md）
├── docs/             # 文档站点与线上部署细则
│   └── deploy-online/  # MySQL / Redis / Nginx / PM2 / 总流程
├── .idea/            # WebStorm 运行/打包配置（可提交）
├── .vscode/          # VS Code 调试配置（可选）
├── BUILD.md          # 本地运行 vs 打包
├── DEPLOY.md         # 部署速查（入口）
├── STRUCTURE.md      # 本文件
├── package.json      # 根脚本：统一启停与打包
└── LICENSE
```

## 各端说明

### 1. 服务端 `server/`（结构端 / 后端）

| 项 | 说明 |
|----|------|
| 技术 | NestJS、TypeORM、MySQL、Redis、JWT |
| 本地启动 | 根目录 `npm run dev:server`，或 WebStorm 配置 `start_server` |
| 配置 | `server/src/config/dev.yml` / `test.yml` / `prod.yml` |
| 打包 | `npm run build:server:prod` 或 `build:server:test` |
| 产物 | `server/dist`，线上用 PM2 跑 `dist/main.js` |
| 进程配置 | `server/ecosystem.config.cjs` |

主要源码：`server/src/module/`（系统、监控、工具等模块）。

### 2. 管理端 `admin-web/`（推荐）

| 项 | 说明 |
|----|------|
| 技术 | Vue3、Vite、Element Plus、Pinia |
| 本地启动 | 根目录 `npm run dev:admin` |
| 环境变量 | `.env.development` / `.env.staging` / `.env.production` |
| 接口前缀 | 开发一般 `/dev-api`；生产示例 `/prod-api` |
| 打包 | `build:admin:prod` / `build:admin:test` |
| 产物 | `admin-web/dist`，交 Nginx 静态托管 |

### 3. 旧前端

旧 Vue 管理端（admin/、admin-vue3/）已移除，统一使用 admin-web。

### 4. 客户端 `uniapp/`

| 项 | 说明 |
|----|------|
| 技术 | uni-app（Vue） |
| 用途 | 面向终端用户的 H5 / 微信小程序 / App |
| 开发 | 用 HBuilderX 打开本目录，或按 `uniapp/package.json` 脚本 |
| 注意 | `unpackage/`、`node_modules/` 不要提交 Git |

接口地址在 uni-app 的请求封装里配置，需指向已部署的 `server`。

## 本地开发推荐顺序

1. 导入 `sql/` 初始库，启动 MySQL、Redis  
2. 改好 `server/src/config/dev.yml`  
3. WebStorm 运行 `start_server` + `start_admin`（或根目录两个 dev 脚本）  
4. 浏览器打开管理端本地地址（以终端输出为准，常见 80/81 或 Vite 端口）

## WebStorm 2026.1

已提供运行配置（`.idea/runConfigurations/`）：

- `start_server` — 启动后端  
- `start_admin` — 启动 React 管理端（圆形原型）  
- `build_prod` / `build_test` — 打生产包 / 测试包  

用 **Open** 打开仓库根目录即可识别。详细说明见 `docs/IDE-WebStorm.md`。

## 文档索引

| 文档 | 内容 |
|------|------|
| `sql/README.md` | 初始库导入 |
| `BUILD.md` | 本地跑 vs 打包 |
| `DEPLOY.md` | 部署速查与产物说明 |
| `docs/deploy-online/` | MySQL / Redis / Nginx / PM2 细则 |
| `docs/IDE-WebStorm.md` | WebStorm 使用说明 |


