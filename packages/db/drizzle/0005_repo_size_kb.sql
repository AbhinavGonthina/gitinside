ALTER TABLE "analyses" ADD COLUMN "repo_size_kb" integer;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_repo_size_kb_check" CHECK ("analyses"."repo_size_kb" >= 0);