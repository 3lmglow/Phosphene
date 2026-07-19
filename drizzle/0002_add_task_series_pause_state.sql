ALTER TABLE `task_series` ADD `paused_at` integer;--> statement-breakpoint
UPDATE `task_series`
SET `paused_at` = (
  SELECT control.`created_at`
  FROM `audit_logs` control
  WHERE control.`entity_type` = 'task_series'
    AND control.`entity_id` = `task_series`.`id`
    AND control.`action` IN ('task_series.paused', 'task_series.resumed')
  ORDER BY control.`created_at` DESC, control.`rowid` DESC
  LIMIT 1
)
WHERE `active` = 0
  AND `paused_at` IS NULL
  AND (
    SELECT control.`action`
    FROM `audit_logs` control
    WHERE control.`entity_type` = 'task_series'
      AND control.`entity_id` = `task_series`.`id`
      AND control.`action` IN ('task_series.paused', 'task_series.resumed')
    ORDER BY control.`created_at` DESC, control.`rowid` DESC
    LIMIT 1
  ) = 'task_series.paused';
