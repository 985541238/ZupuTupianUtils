# 提交 Git 前说明

本文件帮助整理仓库后再推远程。框架结构见 [STRUCTURE.md](./STRUCTURE.md)。

## 建议提交

- 源码：`server/`、`admin-vue3/`、`admin/`、`uniapp/`（不含依赖与产物）
- 初始库：`sql/`
- 文档：`STRUCTURE.md`、`BUILD.md`、`DEPLOY.md`、`docs/`
- IDE：`.idea/runConfigurations/`（WebStorm）、可选 `.vscode/`

## 不要提交

- `node_modules/`、`dist/`、`uniapp/unpackage/`、日志
- 含真实密码的 `prod.yml` / `test.yml`（已在 `.gitignore`）
- `.idea/workspace.xml` 等个人工作区文件

## 克隆后第一步

1. 各子项目 `npm install`（或按文档）
2. 导入 `sql/init.sql`
3. 复制并填写本地 `dev.yml` / 前端 `.env.development`
4. WebStorm 打开根目录，运行 `start_server` + `start_admin_vue3`