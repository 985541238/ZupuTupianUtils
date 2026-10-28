# 数据库初始化说明

## 环境
- 本地 MySQL 5.6+（当前开发机为 MySQL 5.6.19，服务名 MySQL56）
- 字符集 utf8mb4

## 导入

本机 root 无密码时：

```bash
mysql -uroot < sql/init.sql
```

有密码时：

```bash
mysql -uroot -p < sql/init.sql
```

Windows PowerShell：

```powershell
Get-Content .\sql\init.sql -Raw -Encoding UTF8 | & "C:\Program Files\MySQL\MySQL Server 5.6\bin\mysql.exe" -uroot
```

## MySQL 账号（后端连接）

| 项 | 值 |
|---|---|
| host | localhost |
| port | 3306 |
| database | zupu_scan |
| user | zupu |
| password | zupu123 |

## 应用演示登录账号

| 项 | 值 |
|---|---|
| 用户名 | admin |
| 密码 | admin123 |

密码以 bcrypt 形式写入 users.password_hash，明文仅作本地开发标注。

## 表结构

- users：登录用户
- tasks：处理任务（一任务一文件夹）
- task_images：任务内图片及处理参数/裁剪框

## 升级脚本（已有数据库按顺序执行，均可重复执行）

```bash
mysql -uroot zupu_scan < sql/migrate_task_meta.sql
mysql -uroot zupu_scan < sql/migrate_processing_time.sql
mysql -uroot zupu_scan < sql/migrate_ai.sql
mysql -uroot zupu_scan < sql/migrate_model_creds.sql
mysql -uroot zupu_scan < sql/migrate_clean_model.sql
mysql -uroot zupu_scan < sql/migrate_image_ai.sql   # 平台账号 + 图生图大模型处理
```
