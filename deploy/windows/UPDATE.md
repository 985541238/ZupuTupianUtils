# 非首次部署（更新）示例

适用：服务器已部署过（MySQL、Node、Python、计划任务 ZupuWorkbench 都已就绪），只更新代码。

## 1. 本地打包
在项目根目录执行（PowerShell）：
```
powershell -ExecutionPolicy Bypass -File deploy\windows\pack.ps1
```
生成 `zupu-update-yyyyMMdd-HHmm.zip`。包内已排除：node_modules、dist、.git、data、待处理的图片*、新建文件夹、*.log、server/.env。
包内带 `server/.env.production`（线上配置，服务以 --prod 启动时自动使用），**不含** `data/`，不会覆盖线上图片和已处理结果。

## 2. 服务器更新
把 zip 拖到服务器，解压覆盖到 `C:\node\rupuutils\zupu\`，然后：
```
cd C:\node\rupuutils\zupu
npm --prefix server install
npm --prefix admin-web install
npm run build:prod
Stop-ScheduledTask  -TaskName ZupuWorkbench
Start-ScheduledTask -TaskName ZupuWorkbench
```
- 只改了前端：只需 `npm --prefix admin-web run build`，再重启。
- 没改依赖（package.json 没变）：可省略两条 `npm install`。
- 表结构变更程序启动时自动执行，一般不用手动跑 sql。

## 3. 验证
- 浏览器打开 `http://服务器IP:8090`，强制刷新（Ctrl+F5）避免旧前端缓存。
- 看 `logs\server.log` 末尾有无报错（数据库连接、端口占用）。

## 4. 回滚
更新前把 `C:\node\rupuutils\zupu\server\dist` 和 `admin-web\dist` 复制一份备份；出问题时还原这两个目录并重启计划任务即可。

## 一键更新（推荐）
解压覆盖后，直接**双击 `deploy\windows\update.cmd`**（会自动请求管理员权限），它会依次：备份旧编译产物到 `backup\` → 停计划任务并释放 8090 端口 → 安装依赖 → 编译前后端 → 启动计划任务 → 检查端口。上面第 2 步的命令不用再手动敲。
失败时窗口会提示原因；旧版本在 `backup\` 里可还原。
