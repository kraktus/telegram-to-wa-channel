CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_chat_id` text NOT NULL,
	`source_message_id` integer NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `state` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wa_messages` (
	`source_chat_id` text NOT NULL,
	`source_message_id` integer NOT NULL,
	`wa_jid` text NOT NULL,
	`wa_message_id` text NOT NULL,
	CONSTRAINT `wa_messages_pk` PRIMARY KEY(`source_chat_id`, `source_message_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_send_unique` ON `jobs` (`source_chat_id`,`source_message_id`) WHERE "jobs"."operation" = 'send';--> statement-breakpoint
CREATE INDEX `jobs_status_next` ON `jobs` (`status`,`next_attempt_at`);