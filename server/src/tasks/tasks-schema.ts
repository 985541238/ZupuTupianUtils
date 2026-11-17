/** 启动时自动建表/补列（可重复执行），老库升级后不用手工导 SQL。 */
export const TASKS_SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS \`projects\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`user_id\` BIGINT UNSIGNED NOT NULL,
  \`name\` VARCHAR(128) NOT NULL COMMENT '项目名，如 李氏',
  \`surname\` VARCHAR(32) NOT NULL DEFAULT '',
  \`description\` TEXT NULL,
  \`created_at\` DATETIME NOT NULL,
  \`updated_at\` DATETIME NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_projects_user\` (\`user_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** 老库升级：给 tasks 补 project_id（已存在会报错，忽略即可） */
export const TASKS_ALTER_SQL: string[] = [
  "ALTER TABLE `tasks` ADD COLUMN `project_id` BIGINT UNSIGNED NULL COMMENT '所属项目 projects.id' AFTER `user_id`",
  'ALTER TABLE `tasks` ADD KEY `idx_tasks_project` (`project_id`)',
  'ALTER TABLE `task_images` ADD COLUMN `original_source_path` VARCHAR(1024) NULL AFTER `source_path`',
  'ALTER TABLE `task_images` ADD COLUMN `original_deleted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `source_path`',
  'ALTER TABLE `task_images` ADD COLUMN `result_deleted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `result_path`',
  'ALTER TABLE `task_images` ADD COLUMN `split_quad` TEXT NULL AFTER `crop_box`',
  'ALTER TABLE `task_images` ADD COLUMN `final_crop` TEXT NULL AFTER `split_quad`',
  'ALTER TABLE `projects` ADD COLUMN `root_path` VARCHAR(1024) NULL AFTER `description`',
  "ALTER TABLE `tasks` ADD COLUMN `client_type` VARCHAR(16) NOT NULL DEFAULT 'web' COMMENT '创建入口：web/desktop' AFTER `source_folder`",
  'ALTER TABLE `tasks` ADD COLUMN `client_device_id` VARCHAR(128) NULL COMMENT \'创建设备标识\' AFTER `client_type`',
  'ALTER TABLE `task_images` ADD COLUMN `erase_history` TEXT NULL COMMENT \'橡皮擦历史快照(JSON)\' AFTER `ai_result_path`',
  'ALTER TABLE `task_images` ADD COLUMN `algo_processing_time_ms` INT NULL COMMENT \'算法结果耗时\' AFTER `processing_time_ms`',
  'ALTER TABLE `task_images` ADD COLUMN `ai_processing_time_ms` INT NULL COMMENT \'大模型结果耗时\' AFTER `algo_processing_time_ms`',
  "UPDATE `task_images` SET `ai_processing_time_ms` = `processing_time_ms` WHERE `process_mode` = 'ai' AND `ai_processing_time_ms` IS NULL",
  "UPDATE `task_images` SET `algo_processing_time_ms` = `processing_time_ms` WHERE `process_mode` = 'algo' AND `algo_processing_time_ms` IS NULL",
];
