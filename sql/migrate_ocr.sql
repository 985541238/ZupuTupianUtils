-- OCR 独立任务链：ocr_projects（项目）→ ocr_tasks（卷）→ ocr_pages（页）
-- 与图片处理（projects/tasks/task_images）完全独立，可重复执行。
USE `zupu_scan`;

CREATE TABLE IF NOT EXISTS `ocr_projects` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(128) NOT NULL COMMENT '项目名，如 李氏',
  `surname` VARCHAR(32) NOT NULL DEFAULT '',
  `description` TEXT NULL,
  `root_path` VARCHAR(1024) NULL COMMENT '项目根目录，一级子目录自动建卷',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ocr_projects_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ocr_tasks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `project_id` BIGINT UNSIGNED NULL COMMENT '所属 OCR 项目 ocr_projects.id',
  `project_name` VARCHAR(128) NULL,
  `name` VARCHAR(128) NOT NULL COMMENT '卷名',
  `source_task_id` BIGINT UNSIGNED NULL COMMENT '历史遗留（旧版来自图片处理任务）',
  `source_task_name` VARCHAR(128) NULL,
  `source_folder` VARCHAR(1024) NULL COMMENT '卷图片目录',
  `output_folder` VARCHAR(1024) NULL COMMENT 'OCR 输出目录',
  `client_type` VARCHAR(16) NOT NULL DEFAULT 'web',
  `client_device_id` VARCHAR(128) NULL,
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
  KEY `idx_ocr_tasks_project` (`project_id`),
  KEY `idx_ocr_tasks_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ocr_pages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ocr_task_id` BIGINT UNSIGNED NOT NULL,
  `image_id` BIGINT UNSIGNED NULL COMMENT '历史遗留（旧版 task_images.id）',
  `volume_id` BIGINT UNSIGNED NULL COMMENT '历史遗留（旧版 tasks.id）',
  `volume_name` VARCHAR(128) NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `source_path` VARCHAR(1024) NULL COMMENT 'OCR 导入的原图',
  `image_path` VARCHAR(1024) NOT NULL COMMENT '识别所用图（当前=原图）',
  `image_sig` VARCHAR(128) NULL COMMENT '识别时所用图片的签名',
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

-- 老库（旧版 ocr_tasks/ocr_pages）升级请执行 sql/migrate_ocr_standalone.sql
