CREATE TABLE `rooms` (
  `code` text PRIMARY KEY NOT NULL,
  `state` text NOT NULL,
  `revision` integer NOT NULL,
  `p1_seen` integer NOT NULL,
  `p2_seen` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_expiry_idx` ON `rooms` (`expires_at`);
