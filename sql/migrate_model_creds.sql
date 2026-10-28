USE `zupu_scan`;

ALTER TABLE `ai_models`
  ADD COLUMN `base_url` VARCHAR(255) NULL AFTER `model`,
  ADD COLUMN `api_key` TEXT NULL AFTER `base_url`;
