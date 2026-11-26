CREATE TABLE `mcp_counters` (
	`day` text NOT NULL,
	`event` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `mcp_counters_pk` PRIMARY KEY(`day`, `event`)
);
