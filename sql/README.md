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
- projects：图片处理项目（家族/姓氏）
- tasks：图片处理卷（一任务一文件夹）
- task_images：任务内图片及处理参数/裁剪框
- ocr_projects / ocr_tasks / ocr_pages：**OCR 独立任务链**（OCR 项目 → OCR 卷 → 逐页逐字结果），与图片处理完全独立（见 migrate_ocr.sql）

## 升级脚本（已有数据库按顺序执行，均可重复执行）

```bash
mysql -uroot zupu_scan < sql/migrate_task_meta.sql
mysql -uroot zupu_scan < sql/migrate_processing_time.sql
mysql -uroot zupu_scan < sql/migrate_ai.sql
mysql -uroot zupu_scan < sql/migrate_model_creds.sql
mysql -uroot zupu_scan < sql/migrate_clean_model.sql
mysql -uroot zupu_scan < sql/migrate_image_ai.sql   # 平台账号 + 图生图大模型处理
mysql -uroot zupu_scan < sql/migrate_ocr.sql        # OCR 独立任务链（ocr_projects / ocr_tasks / ocr_pages）
```

老库（已有旧版 ocr_tasks / ocr_pages）再补执行：

```bash
mysql -uroot zupu_scan < sql/migrate_ocr_standalone.sql   # 补列/放宽约束，不动图片处理表
```

> 服务启动时也会自动执行等价 DDL（`server/src/ocr/ocr-schema.ts`），正常升级只要重启服务即可；手工执行用于离线建库/巡检。

## 线上建库账号（密码与 server/.env.production 一致）
```sql
CREATE DATABASE IF NOT EXISTS `zupu_scan` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'zupu'@'localhost' IDENTIFIED BY 'Zupu@2026Db';
ALTER USER 'zupu'@'localhost' IDENTIFIED BY 'Zupu@2026Db';
GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'localhost';
FLUSH PRIVILEGES;
```
本地开发仍用 init.sql 的默认账号（zupu / zupu123）。
