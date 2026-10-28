# 族谱数字化工作台

把族谱旧谱的复印/扫描图片变成文字数据，审核后推送给第三方服务。一本谱书就是一个任务，三步走完：

1. **创建任务**：填书名、姓氏，上传整本图片（图片、文件夹、zip 都行），选图片清理方式和识别模型，看费用预估。
2. **处理与预览审核**：后台自动拆页 → 清理 → 阿里云模型识别文字 → 标出疑似错字。逐页对照原图校对，脏页可以点「AI 处理本页」。
3. **推送 / 导出**：审核通过的页按「推送协议 v1」发给第三方；也可以导出 Excel / TXT / JSON（可附图片）。

| 目录 | 说明 |
|---|---|
| `server/` | NestJS 后端：任务、后台处理队列、阿里云调用、推送导出 |
| `server/scripts/` | Python + OpenCV：普通清理算法（scanwash）、双页拆分 |
| `admin-web/` | React + Vite 前端 |
| `sql/` | `init.sql` 全新安装；`migrate_v2.sql` 旧库升级 |

## 运行

依赖：Node 18+、MySQL 5.6+、Python 3.9+（带 `opencv-python`、`numpy`）。

```bash
# 1. 数据库（全新安装；已有数据请改用 migrate_v2.sql）
mysql -uroot -p < sql/init.sql

# 2. Python 依赖
pip install opencv-python numpy

# 3. 后端（端口见 server/.env，默认 8081）
cp server/.env.example server/.env   # 按注释填写
npm --prefix server install
npm run dev:server

# 4. 前端 http://localhost:8888
npm --prefix admin-web install
npm run dev:admin
```

首次启动若没有任何账号，会自动创建 `admin`，密码取 `ADMIN_PASSWORD`（未设置时为 `admin123`）。

登录后先到 **配置** 页：

1. 填阿里云 API Key 和 Base URL，点「测试连接」。
2. 检查模型列表：默认带一个识别模型（qwen3-vl-plus）和一个清理模型（qwen-image-edit），模型名以百炼控制台当前可用的为准；**填上单价**才能预估费用。
3. 填推送地址（第三方还没接口时可以先不填，只用导出）。

### 不调用阿里云，先体验流程

`server/.env` 里加 `AI_MOCK=1`：识别和 AI 清理返回模拟结果，不花钱，用来演示和联调。

### 本机快速自测（不装 MySQL）

```bash
npm --prefix server i better-sqlite3 --no-save
DB_TYPE=sqlite AI_MOCK=1 npm run dev:server
```

## 任务状态与可做的操作

| 状态 | 说明 | 可以 |
|---|---|---|
| 待开始 | 已创建，图片可能还没传完 | 继续上传、删图、开始处理、删除任务 |
| 拆页中 / 处理中 | 后台在跑 | 暂停、审核已处理完的页；**不能删除** |
| 暂停中 | 不再派新页，等正在跑的几页结束 | 继续 |
| 已暂停 | | 继续、审核、删除 |
| 待审核 | 都处理完了 | 审核、一键通过无疑似错字的页、重试失败页、推送已通过的页、导出、删除 |
| 已全部通过 | | 推送、导出、撤销某页通过、删除 |

- 推送中不能删除任务、不能重复推送。
- 阿里云 Key 错、模型名错这类配置问题，任务会**自动暂停**并提示去配置，不会一页页白白失败。
- 后端重启后，正在处理的页自动回到队列接着跑；推送中断的标记为失败，可重推。
- 拆页拆错：审核页「⋯ → 调整拆页」，可以挪中缝重拆、合回单页、把没拆的拆开。

## 推送协议 v1

见配置页「推送接口 → 查看推送协议 v1」，或 `server/src/tasks/payload.ts`。只加字段不改字段，升级时 `schema_version` 变化。

## 部署要点

- `server/.env` 必须设置 `JWT_SECRET`（随机长字符串）；API Key、推送请求头用它派生的密钥加密存库，换了它要重新填 Key。
- 前端 `npm --prefix admin-web run build`，产物 `admin-web/dist` 交给 Nginx；`/dev-api/` 反代到后端端口。
- 第三方要按 `image_url` 取图时，在配置页填「本系统对外地址」，并让 `/public/pages/` 可以从外网访问。
- 处理结果在 `OUTPUT_ROOT`（默认 `data/output`），每个任务一个目录，删任务时一起删除。
