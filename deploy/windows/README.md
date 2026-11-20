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

## 4.1 用 IIS 挂域名（有现成 IIS 的服务器推荐）

服务端是单进程，IIS 只做反向代理，**不需要把 `admin-web\dist` 单独放进 IIS 目录**。

1. 装 IIS 模块：**URL Rewrite 2.0** + **Application Request Routing (ARR)**
2. IIS 管理器 → 点最上层服务器节点 → `Application Request Routing Cache` → 右侧 `Server Proxy Settings` → 勾 **Enable proxy** → 应用
3. 新建站点（与现有站点并列）：
   - 物理路径：`D:\zupu\deploy\windows\iis`（这个目录里已有 `web.config`）
   - 绑定：类型 http，端口 80，主机名填你的域名，例如 `zupu.runfangzhipu.com`
   - 域名先去阿里云/DNS 加 A 记录指向服务器公网 IP
4. 服务器防火墙**不用**放行 8081（只有 IIS 本机访问），放行 80/443 即可
5. 访问 `http://zupu.runfangzhipu.com`，能出登录页、能登录就说明反代通了

要上 HTTPS（顺便解决下面第 5 条的目录选择问题）：IIS 站点 → 绑定 → 添加 https，选已导入的证书。

> 说明：`web.config` 已把上传上限放到 1GB。若 IIS 报 500.19，检查是否漏装 URL Rewrite；报 502 说明 8081 上的 Node 没起来。

## 5. 要点
- 浏览器的“选择目录（showDirectoryPicker）”只在 **https 或 localhost** 下可用。远程用 http://IP 访问时该按钮会退回服务端弹窗（服务器上没人，无意义）。要远程用，请给 8081 前面套 https（IIS / Caddy 反代），或用图片文件夹放服务器上直接填路径。
- 百度 OCR、各模型平台的 Key 在页面「模型配置」里填，保存在数据库（用 `SETTINGS_SECRET` 加密）。
- 数据都在 `OUTPUT_ROOT` / `UPLOAD_ROOT`，备份这两个目录和数据库即可。
- **Node 和 Python 必须装成“所有用户”可用**（安装时选 Install for all users，或装到 `C:\Program Files`）。计划任务以 SYSTEM 身份运行，走的是系统 PATH，装成当前用户路径的话服务启动会报找不到 node / 缺 OpenCV。
- 更新：`git pull` → 再运行 `install.ps1` → `Stop-ScheduledTask / Start-ScheduledTask -TaskName ZupuWorkbench`（走 IIS 反代时刷新页面即可看到新版）。
