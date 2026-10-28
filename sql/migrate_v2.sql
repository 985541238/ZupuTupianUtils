-- ============================================================
-- 升级到 v2（族谱数字化工作台：AI 识别 + 审核 + 推送）
-- 在已有的 zupu_scan 库上执行，可重复执行，不删除任何数据。
--   mysql -uroot -p zupu_scan < sql/migrate_v2.sql
-- 升级后：
--   - 旧任务的书名沿用原任务名，姓氏为空（可在任务页修改）
--   - 旧任务已有的图片作为“页”保留，状态改为“等待处理”，任务改为“已暂停”，
--     到任务页点「继续处理」即可用新流程清理 + 识别
-- ============================================================
USE `zupu_scan`;
SET @db := DATABASE();

-- tasks 新字段
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='surname')=0,
  'ALTER TABLE `tasks` ADD COLUMN `surname` VARCHAR(32) NOT NULL DEFAULT ''''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='remark')=0,
  'ALTER TABLE `tasks` ADD COLUMN `remark` TEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='clean_mode')=0,
  'ALTER TABLE `tasks` ADD COLUMN `clean_mode` VARCHAR(16) NOT NULL DEFAULT ''algo''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='clean_model_id')=0,
  'ALTER TABLE `tasks` ADD COLUMN `clean_model_id` BIGINT UNSIGNED NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='ocr_model_id')=0,
  'ALTER TABLE `tasks` ADD COLUMN `ocr_model_id` BIGINT UNSIGNED NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='split_double')=0,
  'ALTER TABLE `tasks` ADD COLUMN `split_double` TINYINT NOT NULL DEFAULT 1', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='upload_count')=0,
  'ALTER TABLE `tasks` ADD COLUMN `upload_count` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='failed_count')=0,
  'ALTER TABLE `tasks` ADD COLUMN `failed_count` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='uncertain_pages')=0,
  'ALTER TABLE `tasks` ADD COLUMN `uncertain_pages` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='estimated_cost')=0,
  'ALTER TABLE `tasks` ADD COLUMN `estimated_cost` DECIMAL(12,4) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='actual_cost')=0,
  'ALTER TABLE `tasks` ADD COLUMN `actual_cost` DECIMAL(12,4) NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='push_status')=0,
  'ALTER TABLE `tasks` ADD COLUMN `push_status` VARCHAR(16) NOT NULL DEFAULT ''none''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='push_message')=0,
  'ALTER TABLE `tasks` ADD COLUMN `push_message` TEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='pushed_at')=0,
  'ALTER TABLE `tasks` ADD COLUMN `pushed_at` DATETIME NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='started_at')=0,
  'ALTER TABLE `tasks` ADD COLUMN `started_at` DATETIME NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='finished_at')=0,
  'ALTER TABLE `tasks` ADD COLUMN `finished_at` DATETIME NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- task_images 新字段
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='origin_path')=0,
  'ALTER TABLE `task_images` ADD COLUMN `origin_path` VARCHAR(1024) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='side')=0,
  'ALTER TABLE `task_images` ADD COLUMN `side` VARCHAR(1) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='gutter')=0,
  'ALTER TABLE `task_images` ADD COLUMN `gutter` INT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='clean_used')=0,
  'ALTER TABLE `task_images` ADD COLUMN `clean_used` VARCHAR(16) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='candidate_path')=0,
  'ALTER TABLE `task_images` ADD COLUMN `candidate_path` VARCHAR(1024) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='candidate_ocr')=0,
  'ALTER TABLE `task_images` ADD COLUMN `candidate_ocr` TEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='candidate_cost')=0,
  'ALTER TABLE `task_images` ADD COLUMN `candidate_cost` DECIMAL(12,4) NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='action')=0,
  'ALTER TABLE `task_images` ADD COLUMN `action` VARCHAR(16) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='action_args')=0,
  'ALTER TABLE `task_images` ADD COLUMN `action_args` TEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ocr_model_id')=0,
  'ALTER TABLE `task_images` ADD COLUMN `ocr_model_id` BIGINT UNSIGNED NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='ocr_json')=0,
  'ALTER TABLE `task_images` ADD COLUMN `ocr_json` MEDIUMTEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='uncertain_count')=0,
  'ALTER TABLE `task_images` ADD COLUMN `uncertain_count` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='edited')=0,
  'ALTER TABLE `task_images` ADD COLUMN `edited` TINYINT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='cost')=0,
  'ALTER TABLE `task_images` ADD COLUMN `cost` DECIMAL(12,4) NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='tokens_in')=0,
  'ALTER TABLE `task_images` ADD COLUMN `tokens_in` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='tokens_out')=0,
  'ALTER TABLE `task_images` ADD COLUMN `tokens_out` INT NOT NULL DEFAULT 0', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='push_status')=0,
  'ALTER TABLE `task_images` ADD COLUMN `push_status` VARCHAR(16) NOT NULL DEFAULT ''none''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='push_error')=0,
  'ALTER TABLE `task_images` ADD COLUMN `push_error` TEXT NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='pushed_at')=0,
  'ALTER TABLE `task_images` ADD COLUMN `pushed_at` DATETIME NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 旧字段放宽（新代码不再写入）
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='source_type')=1,
  'ALTER TABLE `tasks` MODIFY COLUMN `source_type` VARCHAR(32) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='tasks' AND COLUMN_NAME='page_form')=1,
  'ALTER TABLE `tasks` MODIFY COLUMN `page_form` VARCHAR(32) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
ALTER TABLE `task_images` MODIFY COLUMN `ocr_json` MEDIUMTEXT NULL;

CREATE TABLE IF NOT EXISTS `settings` (
  `k` VARCHAR(64) NOT NULL,
  `v` TEXT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `ai_models` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `purpose` VARCHAR(16) NOT NULL,
  `display_name` VARCHAR(64) NOT NULL,
  `model` VARCHAR(128) NOT NULL,
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
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_models_purpose` (`purpose`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 旧数据转成新状态（只处理还没转换过的行）
UPDATE `task_images` SET `status`='pending', `action`=NULL
  WHERE `ocr_json` IS NULL AND `status` IN ('ready','confirmed','rejected','processing','done');
UPDATE `task_images` SET `origin_path`=`source_path` WHERE `origin_path` IS NULL;
UPDATE `tasks` t SET
  t.`upload_count` = (SELECT COUNT(*) FROM `task_images` i WHERE i.`task_id`=t.`id`),
  t.`total_count`  = (SELECT COUNT(*) FROM `task_images` i WHERE i.`task_id`=t.`id`)
  WHERE t.`status` IN ('pending','processing','reviewing','completed','failed');
UPDATE `tasks` SET `status`='paused', `split_double`=0,
  `error_message`='系统已升级：点「继续处理」用新流程清理并识别这本书'
  WHERE `status` IN ('pending','processing','reviewing','completed','failed') AND `total_count` > 0;
UPDATE `tasks` SET `status`='draft' WHERE `status` IN ('pending','failed') AND `total_count` = 0;
