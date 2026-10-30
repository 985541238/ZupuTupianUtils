# Windows 服务器部署

单进程部署：Node 服务同端口提供接口和管理端页面，**不需要 Nginx**。

## 1. 准备（一次性）
| 软件 | 版本 | 说明 |
|---|---|---|
| Node.js | 20 / 22 LTS | 服务端与前端构建 |
| Python | 3.10+（加入 PATH） | 图片处理、透视修正用 OpenCV |
| MySQL | 5.6+ | 账号、任务数据 |
| Git | 任意 | 拉代码 |

## 2. 拉代码并安装
```powershell
git clone https://github.com/985541238/ZupuTupianUtils.git D:\zupu
cd D:\zupu
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1   # 管理员 PowerShell
```
脚本会装依赖、构建前后端、生成 `server\.env`（JWT 等密钥随机生成）、注册开机自启。

## 3. 建库
```sql
CREATE DATABASE zupu_scan DEFAULT CHARSET utf8mb4;
CREATE USER 'zupu'@'localhost' IDENTIFIED BY '你的密码';
GRANT ALL ON zupu_scan.* TO 'zupu'@'localhost';
```
然后依次导入 `sql\init.sql`，再导入 `sql\migrate_*.sql`（报“列已存在”可忽略）。把密码填进 `server\.env` 的 `DB_PASS`。

## 4. 启动与访问
```powershell
Start-ScheduledTask -TaskName ZupuWorkbench
```
浏览器打开 `http://服务器IP:8081`。日志在 `logs\server.log`。防火墙放行 8081：
```powershell
New-NetFirewallRule -DisplayName Zupu -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow
```
初始账号 `admin` / `admin123`（写在 `sql\init.sql`）。**首次登录后立刻点右上角头像改账号和密码。**

## 5. 要点
- 浏览器的“选择目录（showDirectoryPicker）”只在 **https 或 localhost** 下可用。远程用 http://IP 访问时该按钮会退回服务端弹窗（服务器上没人，无意义）。要远程用，请给 8081 前面套 https（IIS / Caddy 反代），或用图片文件夹放服务器上直接填路径。
- 百度 OCR、各模型平台的 Key 在页面「模型配置」里填，保存在数据库（用 `SETTINGS_SECRET` 加密）。
- 数据都在 `OUTPUT_ROOT` / `UPLOAD_ROOT`，备份这两个目录和数据库即可。
- 更新：`git pull` → 再运行 `install.ps1` → `Stop-ScheduledTask / Start-ScheduledTask -TaskName ZupuWorkbench`。
