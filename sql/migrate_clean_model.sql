SELECT COUNT(*) INTO @c FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'clean_model_id';
SET @sql = IF(@c = 0,
  'ALTER TABLE tasks ADD COLUMN clean_model_id BIGINT UNSIGNED NULL COMMENT ''AI图片处理模型'' AFTER ocr_model_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
