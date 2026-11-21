ALTER TABLE "pull_requests" ADD COLUMN "rules_config" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "rules_config_changed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_rules_config_check" CHECK (("pull_requests"."rules_config" is null or "pull_requests"."diff_key" is not null)
        and ("pull_requests"."rules_config_changed" = false or "pull_requests"."diff_key" is not null)
        and octet_length("pull_requests"."rules_config") <= 65537);