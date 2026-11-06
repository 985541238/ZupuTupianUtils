-- task_images 删除标记字段（幂等，兼容 MySQL 5.6+）
-- original_deleted: 原图文件已从磁盘删除，接口不再返回原图 URL
-- result_deleted:   结果图文件已从磁盘删除，接口不再返回结果 URL
USE `zupu_scan`;

SET @db := DATABASE();

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='original_deleted')=0,
    'ALTER TABLE `task_images` ADD COLUMN `original_deleted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `source_path`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=@db AND TABLE_NAME='task_images' AND COLUMN_NAME='result_deleted')=0,
    'ALTER TABLE `task_images` ADD COLUMN `result_deleted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `result_path`',
    'SELECT 1'
  )
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
