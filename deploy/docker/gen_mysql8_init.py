#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 sql/ 下的原始脚本（MySQL 5.6 语法）合并成一份 MySQL 8 可直接导入的初始化脚本。

原因：sql/init.sql 用 `GRANT ... IDENTIFIED BY '...'`（MySQL 5.6 语法），
在 MySQL 8 上直接报 ERROR 1064，后续建表语句全部中断。

用法：
    python deploy/docker/gen_mysql8_init.py
产出：
    deploy/docker/mysql/init-mysql8.sql
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "sql"
OUT = Path(__file__).resolve().parent / "mysql" / "init-mysql8.sql"

# 执行顺序（init 建表在前，migrate 补列/补表在后）
# 注意：migrate_clean_model.sql 的 ALTER 里写了 AFTER `ocr_model_id`，
# 而该列由 migrate_image_ai.sql 补上，所以 image_ai 必须排在 clean_model 之前
# （image_ai 内的语句都是按列存在性判断的，谁先谁后都不会重复加列）。
ORDER = [
    "init.sql",
    "migrate_task_meta.sql",
    "migrate_processing_time.sql",
    "migrate_ai.sql",
    "migrate_model_creds.sql",
    "migrate_image_ai.sql",
    "migrate_clean_model.sql",
    "migrate_ocr.sql",
]

DB = "zupu_scan"
USER = "zupu"
PASS = "zupu123"

HEADER = f"""-- ============================================================
-- 族谱扫描清理工具 · MySQL 8 一键初始化脚本
-- 由 deploy/docker/gen_mysql8_init.py 自动生成，请勿手工修改
-- 生成来源：sql/init.sql + sql/migrate_*.sql（原文件保持 MySQL 5.6 语法不动）
--
-- 与原始脚本的唯一差异：
--   1. 去掉 `GRANT ... IDENTIFIED BY`（MySQL 8 已移除该语法，会中断后续建表）
--   2. 改用 CREATE USER IF NOT EXISTS + GRANT 两步完成授权
--   3. 每个子脚本前加 USE `{DB}`，兼容 mysql8 容器 entrypoint 默认库为空的情况
--
-- 导入：
--   mysql -h <host> -P <port> -u root -p < init-mysql8.sql
-- ============================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `{DB}`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

-- 应用账号（MySQL 8 写法）；已存在则只改密码/补授权
CREATE USER IF NOT EXISTS '{USER}'@'%' IDENTIFIED BY '{PASS}';
ALTER USER '{USER}'@'%' IDENTIFIED BY '{PASS}';
GRANT ALL PRIVILEGES ON `{DB}`.* TO '{USER}'@'%';
FLUSH PRIVILEGES;

USE `{DB}`;
"""

# 需要整条剔除的 MySQL 5.6 专有语句（按语句首行匹配，可能跨多行，一直删到分号结束）
DROP_STATEMENT_STARTS = [
    re.compile(r"^\s*GRANT\b", re.I),
    re.compile(r"^\s*FLUSH\s+PRIVILEGES\b", re.I),
    re.compile(r"^\s*CREATE\s+DATABASE\b", re.I),
]


def _is_statement_start(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith("--") or stripped.startswith("#"):
        return False
    return any(p.match(line) for p in DROP_STATEMENT_STARTS)


def strip_56_only(text: str) -> str:
    """删除 GRANT / FLUSH / CREATE DATABASE 语句（支持跨多行的语句）。"""
    out = []
    skipping = False
    for line in text.splitlines():
        if skipping:
            # 一直跳到分号结束
            if line.rstrip().endswith(";"):
                skipping = False
            continue
        if _is_statement_start(line):
            if not line.rstrip().endswith(";"):
                skipping = True
            continue
        out.append(line)
    return "\n".join(out).strip()


# 个别脚本本身不幂等（在「全新库」场景下会与前面的建表语句冲突），
# 这里按文件名在合并时替换成等价、可重复执行的写法。
REPLACEMENTS = {
    # 原文：ALTER TABLE ai_models ADD COLUMN base_url ..., ADD COLUMN api_key ...;
    # 问题：migrate_ai.sql 的 CREATE TABLE 已包含这两列，新库执行必报 ERROR 1060 (Duplicate column)。
    "migrate_model_creds.sql": """-- 原语句不幂等（migrate_ai.sql 建表已含 base_url / api_key，直接 ALTER 会报 1060）
-- 改为按列存在性判断的动态 SQL，可重复执行
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_models' AND COLUMN_NAME = 'base_url');
SET @s := IF(@c = 0,
  'ALTER TABLE `ai_models` ADD COLUMN `base_url` VARCHAR(255) NULL AFTER `model`',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_models' AND COLUMN_NAME = 'api_key');
SET @s := IF(@c = 0,
  'ALTER TABLE `ai_models` ADD COLUMN `api_key` TEXT NULL AFTER `base_url`',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;""",
}


def main() -> int:
    if not SQL_DIR.is_dir():
        print(f"找不到 sql 目录：{SQL_DIR}", file=sys.stderr)
        return 1

    parts = [HEADER]
    for name in ORDER:
        f = SQL_DIR / name
        if not f.is_file():
            print(f"缺少脚本：{name}", file=sys.stderr)
            return 1
        if name in REPLACEMENTS:
            body = REPLACEMENTS[name]
        else:
            body = strip_56_only(f.read_text(encoding="utf-8-sig"))
        parts.append(
            f"\n-- ==================== {name} ====================\n"
            f"USE `{DB}`;\n{body}\n"
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"已生成 {OUT} （{OUT.stat().st_size} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
