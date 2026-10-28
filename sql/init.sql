-- ============================================================
-- 族谱数字化工作台 · 数据库初始化（全新安装用，会清空旧表！）
-- 兼容 MySQL 5.6+ / 5.7 / 8.x，字符集 utf8mb4
-- 已有数据要升级，请用 migrate_v2.sql，不要执行本文件。
--
-- 导入：mysql -uroot -p < sql/init.sql
-- 登录账号：首次启动后端时，若 users 表为空会自动创建 admin，
--           密码取 server/.env 的 ADMIN_PASSWORD（未设置时为 admin123，请尽快修改）。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `zupu_scan` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- 后端连接账号：密码请改成自己的，并同步写到 server/.env 的 DB_PASS
GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'localhost' IDENTIFIED BY 'zupu123';
GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'127.0.0.1' IDENTIFIED BY 'zupu123';
FLUSH PRIVILEGES;

USE `zupu_scan`;

DROP TABLE IF EXISTS `task_images`;
DROP TABLE IF EXISTS `tasks`;
DROP TABLE IF EXISTS `ai_models`;
DROP TABLE IF EXISTS `settings`;
DROP TABLE IF EXISTS `users`;

CREATE TABLE `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `display_name` VARCHAR(64) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `tasks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(128) NOT NULL COMMENT '书名',
  `surname` VARCHAR(32) NOT NULL DEFAULT '' COMMENT '姓氏',
  `remark` TEXT NULL COMMENT '备注',
  `clean_mode` VARCHAR(16) NOT NULL DEFAULT 'algo' COMMENT 'algo 普通清理 | ai 模型清理',
  `clean_model_id` BIGINT UNSIGNED NULL,
  `ocr_model_id` BIGINT UNSIGNED NULL,
  `split_double` TINYINT NOT NULL DEFAULT 1 COMMENT '双页拼印自动拆页',
  `source_folder` VARCHAR(1024) NOT NULL COMMENT '上传目录',
  `output_folder` VARCHAR(1024) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft' COMMENT 'draft|preparing|processing|pausing|paused|reviewing|completed',
  `upload_count` INT NOT NULL DEFAULT 0,
  `total_count` INT NOT NULL DEFAULT 0,
  `done_count` INT NOT NULL DEFAULT 0,
  `confirmed_count` INT NOT NULL DEFAULT 0,
  `failed_count` INT NOT NULL DEFAULT 0,
  `uncertain_pages` INT NOT NULL DEFAULT 0,
  `estimated_cost` DECIMAL(12,4) NULL,
  `actual_cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `push_status` VARCHAR(16) NOT NULL DEFAULT 'none' COMMENT 'none|pushing|success|partial|failed',
  `push_message` TEXT NULL,
  `pushed_at` DATETIME NULL,
  `error_message` TEXT NULL,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tasks_user` (`user_id`),
  KEY `idx_tasks_status` (`status`),
  CONSTRAINT `fk_tasks_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `task_images` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_id` BIGINT UNSIGNED NOT NULL,
  `file_name` VARCHAR(255) NOT NULL COMMENT '上传时的文件名',
  `origin_path` VARCHAR(1024) NULL COMMENT '上传的整张原图（拆页前）',
  `side` VARCHAR(1) NULL COMMENT 'R 右页 | L 左页 | NULL 未拆',
  `gutter` INT NULL COMMENT '拆页中缝 x',
  `source_path` VARCHAR(1024) NOT NULL COMMENT '本页原图',
  `result_path` VARCHAR(1024) NULL COMMENT '清理后',
  `thumb_path` VARCHAR(1024) NULL,
  `clean_used` VARCHAR(16) NULL,
  `candidate_path` VARCHAR(1024) NULL COMMENT 'AI 处理本页的待选结果',
  `candidate_ocr` TEXT NULL,
  `candidate_cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|queued|processing|review|approved|failed',
  `action` VARCHAR(16) NULL COMMENT '单页操作：process|ai_clean|reocr',
  `action_args` TEXT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `width` INT NULL,
  `height` INT NULL,
  `ocr_model_id` BIGINT UNSIGNED NULL,
  `ocr_json` MEDIUMTEXT NULL COMMENT '识别结果 JSON',
  `uncertain_count` INT NOT NULL DEFAULT 0,
  `edited` TINYINT NOT NULL DEFAULT 0,
  `cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `tokens_in` INT NOT NULL DEFAULT 0,
  `tokens_out` INT NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `processing_time_ms` INT NULL,
  `push_status` VARCHAR(16) NOT NULL DEFAULT 'none',
  `push_error` TEXT NULL,
  `pushed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_images_task` (`task_id`, `sort_order`),
  KEY `idx_images_status` (`status`),
  CONSTRAINT `fk_images_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `settings` (
  `k` VARCHAR(64) NOT NULL,
  `v` TEXT NULL COMMENT 'JSON；密钥已加密',
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `ai_models` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purpose` VARCHAR(16) NOT NULL COMMENT 'ocr 文字识别 | clean 图片清理',
  `display_name` VARCHAR(64) NOT NULL,
  `model` VARCHAR(128) NOT NULL COMMENT '百炼模型代码',
  `prompt` TEXT NULL,
  `billing` VARCHAR(16) NOT NULL DEFAULT 'token' COMMENT 'token | image',
  `price_in` DECIMAL(12,6) NULL COMMENT '元/千 token',
  `price_out` DECIMAL(12,6) NULL COMMENT '元/千 token',
  `price_image` DECIMAL(12,6) NULL COMMENT '元/张',
  `avg_tokens_in` INT NOT NULL DEFAULT 3000,
  `avg_tokens_out` INT NOT NULL DEFAULT 1000,
  `enable_thinking` TINYINT NOT NULL DEFAULT 0,
  `is_default` TINYINT NOT NULL DEFAULT 0,
  `enabled` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_models_purpose` (`purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
