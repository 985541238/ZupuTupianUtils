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
