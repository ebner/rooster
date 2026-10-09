-- Phase 6/8 hardening. Idempotency rows must never hold a PAT in plaintext: a stored
-- `POST /me/tokens` response from before this release is dropped (a replay now gets
-- `409 token_shown_once`).
DELETE FROM `idempotency` WHERE `response` LIKE '%rooster\_pat\_%' ESCAPE '\';
--> statement-breakpoint
-- Follower backfill (FR-COL): tasks of shared orgs created before auto-follow existed get
-- their creator and assignee as followers, when they are still members. Existing rows, muted
-- ones included, are left as they are.
INSERT OR IGNORE INTO `follower` (`task_id`, `user_id`, `muted`)
SELECT t.`id`, t.`created_by`, 0
FROM `task` t
JOIN `organization` o ON o.`id` = t.`org_id` AND o.`is_personal` = 0
JOIN `member` m ON m.`organization_id` = t.`org_id` AND m.`user_id` = t.`created_by`;
--> statement-breakpoint
INSERT OR IGNORE INTO `follower` (`task_id`, `user_id`, `muted`)
SELECT t.`id`, t.`assignee_id`, 0
FROM `task` t
JOIN `organization` o ON o.`id` = t.`org_id` AND o.`is_personal` = 0
JOIN `member` m ON m.`organization_id` = t.`org_id` AND m.`user_id` = t.`assignee_id`
WHERE t.`assignee_id` IS NOT NULL;
