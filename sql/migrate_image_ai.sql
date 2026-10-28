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
