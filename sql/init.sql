-- ============================================================
-- 族谱古书扫描处理工具 · 本地数据库初始化
-- 兼容 MySQL 5.6+
-- ============================================================
-- 【应用演示账号】（登录网页用）
--   用户名: admin
--   密码:   admin123
-- 【MySQL 连接】（后端 .env 使用）
--   host:     localhost
--   port:     3306
--   database: zupu_scan
--   user:     zupu
--   password: zupu123
-- 导入示例:
--   mysql -uroot < sql/init.sql
--   （本机 root 若无密码则直接如上；有密码则加 -p）
-- ============================================================

CREATE DATABASE IF NOT EXISTS `zupu_scan`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'localhost' IDENTIFIED BY 'zupu123';
GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'127.0.0.1' IDENTIFIED BY 'zupu123';
FLUSH PRIVILEGES;

USE `zupu_scan`;

DROP TABLE IF EXISTS `task_images`;
DROP TABLE IF EXISTS `tasks`;
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
  `name` VARCHAR(128) NOT NULL,
  `description` TEXT NULL COMMENT '任务说明',
  `source_type` VARCHAR(32) NOT NULL DEFAULT '复印' COMMENT '影像来源:复印|扫描|拍照',
  `page_form` VARCHAR(32) NOT NULL DEFAULT '双联' COMMENT '页面形态:双联|单页',
  `issues` TEXT NULL COMMENT '常见问题 JSON 数组',
  `genealogy_note` VARCHAR(255) NULL COMMENT '姓氏/谱系备注',
  `source_folder` VARCHAR(1024) NOT NULL,
  `output_folder` VARCHAR(1024) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|processing|reviewing|completed|failed',
  `total_count` INT NOT NULL DEFAULT 0,
  `done_count` INT NOT NULL DEFAULT 0,
  `confirmed_count` INT NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `default_params` TEXT NULL COMMENT 'JSON params',
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
  `file_name` VARCHAR(255) NOT NULL,
  `source_path` VARCHAR(1024) NOT NULL,
  `result_path` VARCHAR(1024) NULL,
  `thumb_path` VARCHAR(1024) NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|processing|ready|confirmed|failed',
  `sort_order` INT NOT NULL DEFAULT 0,
  `width` INT NULL,
  `height` INT NULL,
  `params` TEXT NULL,
  `crop_box` TEXT NULL,
  `error_message` TEXT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_images_task` (`task_id`),
  KEY `idx_images_status` (`status`),
  CONSTRAINT `fk_images_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `users` (`username`, `password_hash`, `display_name`, `created_at`, `updated_at`) VALUES
('admin', '$2b$10$kjjkvV0mf.dLP7FWPhJgm.pxdHnlVicMsRDuxsZ0qC/oru6i/OqTm', '管理员', NOW(), NOW());