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
