-- ============================================================
-- 族谱扫描清理工具 · MySQL 8 一键初始化脚本
-- 由 deploy/docker/gen_mysql8_init.py 自动生成，请勿手工修改
-- 生成来源：sql/init.sql + sql/migrate_*.sql（原文件保持 MySQL 5.6 语法不动）
--
-- 与原始脚本的唯一差异：
--   1. 去掉 `GRANT ... IDENTIFIED BY`（MySQL 8 已移除该语法，会中断后续建表）
--   2. 改用 CREATE USER IF NOT EXISTS + GRANT 两步完成授权
--   3. 每个子脚本前加 USE `zupu_scan`，兼容 mysql8 容器 entrypoint 默认库为空的情况
--
-- 导入：
--   mysql -h <host> -P <port> -u root -p < init-mysql8.sql
-- ============================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `zupu_scan`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

-- 应用账号（MySQL 8 写法）；已存在则只改密码/补授权
CREATE USER IF NOT EXISTS 'zupu'@'%' IDENTIFIED BY 'zupu123';
ALTER USER 'zupu'@'%' IDENTIFIED BY 'zupu123';
GRANT ALL PRIVILEGES ON `zupu_scan`.* TO 'zupu'@'%';
FLUSH PRIVILEGES;

USE `zupu_scan`;


-- ==================== init.sql ====================
USE `zupu_scan`;
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
  `processing_time_ms` INT NULL COMMENT '最近一次批量处理 wall-clock 毫秒',
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
  `processing_time_ms` INT NULL COMMENT '单张处理耗时毫秒',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_images_task` (`task_id`),
  KEY `idx_images_status` (`status`),
  CONSTRAINT `fk_images_task` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `users` (`username`, `password_hash`, `display_name`, `created_at`, `updated_at`) VALUES
('admin', '$2b$10$kjjkvV0mf.dLP7FWPhJgm.pxdHnlVicMsRDuxsZ0qC/oru6i/OqTm', '管理员', NOW(), NOW());


-- ==================== migrate_task_meta.sql ====================
USE `zupu_scan`;
-- 族谱新建任务字段扩展（兼容 MySQL 5.6+）
USE `zupu_scan`;

SET @db := DATABASE();

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='description')=0,
    'ALTER TABLE `tasks` ADD COLUMN `description` TEXT NULL COMMENT ''任务说明'' AFTER `name`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='source_type')=0,
    'ALTER TABLE `tasks` ADD COLUMN `source_type` VARCHAR(32) NOT NULL DEFAULT ''复印'' COMMENT ''影像来源:复印|扫描|拍照'' AFTER `description`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='page_form')=0,
    'ALTER TABLE `tasks` ADD COLUMN `page_form` VARCHAR(32) NOT NULL DEFAULT ''双联'' COMMENT ''页面形态:双联|单页'' AFTER `source_type`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='issues')=0,
    'ALTER TABLE `tasks` ADD COLUMN `issues` TEXT NULL COMMENT ''常见问题 JSON 数组'' AFTER `page_form`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='genealogy_note')=0,
    'ALTER TABLE `tasks` ADD COLUMN `genealogy_note` VARCHAR(255) NULL COMMENT ''姓氏/谱系备注'' AFTER `issues`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ==================== migrate_processing_time.sql ====================
USE `zupu_scan`;
-- 处理耗时字段（幂等，兼容 MySQL 5.6+）
-- tasks.processing_time_ms: 最近一次批量 runProcess 的 wall-clock（开始到结束；中途取消则写已花费时间）
-- task_images.processing_time_ms: 单张 processToFile(+thumb) 耗时；单张 reprocess/preview 只更新该图，不改任务批量总耗时
USE `zupu_scan`;

SET @db := DATABASE();

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='processing_time_ms')=0,
    'ALTER TABLE `tasks` ADD COLUMN `processing_time_ms` INT NULL COMMENT ''最近一次批量处理 wall-clock 毫秒'' AFTER `default_params`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='processing_time_ms')=0,
    'ALTER TABLE `task_images` ADD COLUMN `processing_time_ms` INT NULL COMMENT ''单张处理耗时毫秒'' AFTER `error_message`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ==================== migrate_ai.sql ====================
USE `zupu_scan`;
USE `zupu_scan`;
SET @db := DATABASE();
CREATE TABLE IF NOT EXISTS `settings` (
  `k` VARCHAR(64) NOT NULL,
  `v` TEXT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS `ai_models` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purpose` VARCHAR(16) NOT NULL,
  `display_name` VARCHAR(64) NOT NULL,
  `model` VARCHAR(128) NOT NULL,
  `base_url` VARCHAR(255) NULL,
  `api_key` TEXT NULL,
  `prompt` TEXT NULL,
  `billing` VARCHAR(16) NOT NULL DEFAULT 'token',
  `price_in` DECIMAL(12,6) NULL,
  `price_out` DECIMAL(12,6) NULL,
  `price_image` DECIMAL(12,6) NULL,
  `avg_tokens_in` INT NOT NULL DEFAULT 3000,
  `avg_tokens_out` INT NOT NULL DEFAULT 1000,
  `enable_thinking` TINYINT NOT NULL DEFAULT 0,
  `is_default` TINYINT NOT NULL DEFAULT 0,
  `enabled` TINYINT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_models_purpose` (`purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ==================== migrate_model_creds.sql ====================
USE `zupu_scan`;
-- 原语句不幂等（migrate_ai.sql 建表已含 base_url / api_key，直接 ALTER 会报 1060）
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
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ==================== migrate_image_ai.sql ====================
USE `zupu_scan`;
-- 图片处理接入图生图大模型 + 平台账号（兼容 MySQL 5.6+，可重复执行）
-- 需先执行过 migrate_ai.sql / migrate_model_creds.sql / migrate_clean_model.sql
USE `zupu_scan`;

SET @db := DATABASE();

-- 补齐实体已使用、但历史脚本未建的列（已存在则跳过）
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='surname')=0,
    'ALTER TABLE `tasks` ADD COLUMN `surname` VARCHAR(32) NOT NULL DEFAULT '''' COMMENT ''姓氏''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='ocr_model_id')=0,
    'ALTER TABLE `tasks` ADD COLUMN `ocr_model_id` BIGINT UNSIGNED NULL COMMENT ''AI识别模型''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='clean_model_id')=0,
    'ALTER TABLE `tasks` ADD COLUMN `clean_model_id` BIGINT UNSIGNED NULL COMMENT ''图生图大模型''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='estimated_cost')=0,
    'ALTER TABLE `tasks` ADD COLUMN `estimated_cost` DECIMAL(12,4) NULL COMMENT ''预估费用''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='actual_cost')=0,
    'ALTER TABLE `tasks` ADD COLUMN `actual_cost` DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT ''实际费用''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ocr_model_id')=0,
    'ALTER TABLE `task_images` ADD COLUMN `ocr_model_id` BIGINT UNSIGNED NULL',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ocr_json')=0,
    'ALTER TABLE `task_images` ADD COLUMN `ocr_json` MEDIUMTEXT NULL',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='cost')=0,
    'ALTER TABLE `task_images` ADD COLUMN `cost` DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT ''识别费用''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='tokens_in')=0,
    'ALTER TABLE `task_images` ADD COLUMN `tokens_in` INT NOT NULL DEFAULT 0',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='tokens_out')=0,
    'ALTER TABLE `task_images` ADD COLUMN `tokens_out` INT NOT NULL DEFAULT 0',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 本次新增
SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='error_code')=0,
    'ALTER TABLE `tasks` ADD COLUMN `error_code` VARCHAR(64) NULL COMMENT ''出错类型:平台，如 arrears:ark''',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ai_models' AND COLUMN_NAME='platform')=0,
    'ALTER TABLE `ai_models` ADD COLUMN `platform` VARCHAR(32) NULL COMMENT ''所属平台:ark|aliyun|baidu|tencent|zhipu|deepseek'' AFTER `model`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ai_models' AND COLUMN_NAME='output_size')=0,
    'ALTER TABLE `ai_models` ADD COLUMN `output_size` VARCHAR(32) NULL COMMENT ''图片处理输出尺寸，空=按原图比例'' AFTER `platform`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='process_mode')=0,
    'ALTER TABLE `task_images` ADD COLUMN `process_mode` VARCHAR(16) NULL COMMENT ''当前结果来源:algo|ai'' AFTER `result_path`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='algo_result_path')=0,
    'ALTER TABLE `task_images` ADD COLUMN `algo_result_path` VARCHAR(1024) NULL COMMENT ''算法结果'' AFTER `process_mode`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ai_result_path')=0,
    'ALTER TABLE `task_images` ADD COLUMN `ai_result_path` VARCHAR(1024) NULL COMMENT ''大模型结果'' AFTER `algo_result_path`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ai_model_id')=0,
    'ALTER TABLE `task_images` ADD COLUMN `ai_model_id` BIGINT UNSIGNED NULL COMMENT ''生成大模型结果的模型'' AFTER `ai_result_path`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='clean_cost')=0,
    'ALTER TABLE `task_images` ADD COLUMN `clean_cost` DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT ''图片处理费用(元)'' AFTER `ai_model_id`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 老数据：选了大模型的任务，已有结果图记为大模型结果；其余记为算法结果
UPDATE `task_images` ti JOIN `tasks` t ON ti.`task_id` = t.`id`
  SET ti.`process_mode` = 'ai', ti.`ai_result_path` = ti.`result_path`, ti.`ai_model_id` = t.`clean_model_id`
  WHERE ti.`result_path` IS NOT NULL AND ti.`process_mode` IS NULL AND t.`clean_model_id` IS NOT NULL;

UPDATE `task_images`
  SET `process_mode` = 'algo', `algo_result_path` = `result_path`
  WHERE `result_path` IS NOT NULL AND `process_mode` IS NULL;

-- 老模型：按地址补上所属平台
UPDATE `ai_models` SET `platform` = 'ark'    WHERE `platform` IS NULL AND `base_url` LIKE '%volces.com%';
UPDATE `ai_models` SET `platform` = 'aliyun' WHERE `platform` IS NULL AND (`base_url` LIKE '%aliyuncs.com%' OR `base_url` IS NULL OR `base_url` = '');
UPDATE `ai_models` SET `display_name` = REPLACE(`display_name`, '清理-', '图片处理-') WHERE `purpose` = 'clean';


-- ==================== migrate_clean_model.sql ====================
USE `zupu_scan`;
SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'clean_model_id';
SET @sql = IF(@c = 0,
  'ALTER TABLE tasks ADD COLUMN clean_model_id BIGINT UNSIGNED NULL COMMENT ''AI图片处理模型'' AFTER ocr_model_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ==================== migrate_ocr.sql ====================
USE `zupu_scan`;
-- OCR 识别任务：与图片处理任务分开。可重复执行。
CREATE TABLE IF NOT EXISTS `ocr_tasks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `source_task_id` BIGINT UNSIGNED NOT NULL COMMENT '来源：已完成的图片处理任务 tasks.id',
  `source_task_name` VARCHAR(128) NOT NULL DEFAULT '',
  `ocr_model_id` BIGINT UNSIGNED NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|processing|reviewing|completed|failed',
  `total_count` INT NOT NULL DEFAULT 0,
  `done_count` INT NOT NULL DEFAULT 0 COMMENT '已识别页数',
  `confirmed_count` INT NOT NULL DEFAULT 0 COMMENT '已人工确认页数',
  `error_message` TEXT NULL,
  `error_code` VARCHAR(64) NULL,
  `estimated_cost` DECIMAL(12,4) NULL,
  `actual_cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `processing_time_ms` INT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ocr_tasks_user` (`user_id`),
  KEY `idx_ocr_tasks_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ocr_pages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ocr_task_id` BIGINT UNSIGNED NOT NULL,
  `image_id` BIGINT UNSIGNED NOT NULL COMMENT '对应 task_images.id',
  `file_name` VARCHAR(255) NOT NULL,
  `image_path` VARCHAR(1024) NOT NULL COMMENT '识别所用的处理后图片',
  `image_sig` VARCHAR(128) NULL COMMENT '识别时所用图片的签名，图片处理里重新调整后会变',
  `sort_order` INT NOT NULL DEFAULT 0,
  `width` INT NULL,
  `height` INT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|processing|ready|confirmed|failed',
  `data_json` MEDIUMTEXT NULL COMMENT '逐列逐字结果 {columns:[{id,box,chars:[{t,b,u,e,alt,r}]}]}',
  `model_name` VARCHAR(128) NULL COMMENT '识别本页的模型',
  `prev_data_json` MEDIUMTEXT NULL COMMENT '重新识别前的上一版',
  `prev_model_name` VARCHAR(128) NULL,
  `error_message` TEXT NULL,
  `char_count` INT NOT NULL DEFAULT 0,
  `uncertain_count` INT NOT NULL DEFAULT 0,
  `cost` DECIMAL(12,4) NOT NULL DEFAULT 0,
  `tokens_in` INT NOT NULL DEFAULT 0,
  `tokens_out` INT NOT NULL DEFAULT 0,
  `processing_time_ms` INT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ocr_pages_task` (`ocr_task_id`),
  CONSTRAINT `fk_ocr_pages_task` FOREIGN KEY (`ocr_task_id`) REFERENCES `ocr_tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 老库升级（已有 ocr_pages 表时执行一次；启动时服务也会自动补，列已存在会忽略）
-- ALTER TABLE `ocr_pages` ADD COLUMN `image_sig` VARCHAR(128) NULL AFTER `image_path`;
-- ALTER TABLE `ocr_pages` ADD COLUMN `model_name` VARCHAR(128) NULL, ADD COLUMN `prev_data_json` MEDIUMTEXT NULL, ADD COLUMN `prev_model_name` VARCHAR(128) NULL;

