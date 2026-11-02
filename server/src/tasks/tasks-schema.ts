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
];
