-- 老库升级：把旧版 OCR 表升级为「OCR 独立任务链」（ocr_projects → ocr_tasks 卷 → ocr_pages 页）
-- 可重复执行；只改 ocr_* 表，不触碰图片处理的 projects/tasks/task_images。
USE `zupu_scan`;
SET @db := DATABASE();

-- 1) 新增 OCR 项目表
CREATE TABLE IF NOT EXISTS `ocr_projects` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `surname` VARCHAR(32) NOT NULL DEFAULT '',
  `description` TEXT NULL,
  `root_path` VARCHAR(1024) NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ocr_projects_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) ocr_tasks 补列：source_folder / output_folder / client_type / client_device_id
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='source_folder')=0,
  'ALTER TABLE `ocr_tasks` ADD COLUMN `source_folder` VARCHAR(1024) NULL COMMENT ''卷图片目录''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='output_folder')=0,
  'ALTER TABLE `ocr_tasks` ADD COLUMN `output_folder` VARCHAR(1024) NULL COMMENT ''OCR 输出目录''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='client_type')=0,
  'ALTER TABLE `ocr_tasks` ADD COLUMN `client_type` VARCHAR(16) NOT NULL DEFAULT ''web''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='client_device_id')=0,
  'ALTER TABLE `ocr_tasks` ADD COLUMN `client_device_id` VARCHAR(128) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3) 放宽历史遗留字段约束：source_task_id / source_task_name 允许为空
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='source_task_id' AND IS_NULLABLE='NO')>0,
  'ALTER TABLE `ocr_tasks` MODIFY `source_task_id` BIGINT UNSIGNED NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND COLUMN_NAME='source_task_name' AND IS_NULLABLE='NO')>0,
  'ALTER TABLE `ocr_tasks` MODIFY `source_task_name` VARCHAR(128) NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4) ocr_tasks 项目索引
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_tasks' AND INDEX_NAME='idx_ocr_tasks_project')=0,
  'ALTER TABLE `ocr_tasks` ADD KEY `idx_ocr_tasks_project` (`project_id`)', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 5) ocr_pages 增加原图路径（识别与审阅都直接用原图，不再读图片处理结果）
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_pages' AND COLUMN_NAME='source_path')=0,
  'ALTER TABLE `ocr_pages` ADD COLUMN `source_path` VARCHAR(1024) NULL COMMENT ''OCR 导入的原图''', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 6) 放宽 image_id 约束（新数据不写该字段）
SET @sql := (SELECT IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='ocr_pages' AND COLUMN_NAME='image_id' AND IS_NULLABLE='NO')>0,
  'ALTER TABLE `ocr_pages` MODIFY `image_id` BIGINT UNSIGNED NULL', 'SELECT 1'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 7) 历史数据（如有）：旧版「一项目一条 OCR 任务、页挂在 tasks 卷上」的数据，
--    服务端不再读取旧字段；如需迁移为按卷的新任务，可运行一次性迁移脚本（见 docs 设计文档第 5 节）。
