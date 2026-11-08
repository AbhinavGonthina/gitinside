ALTER TABLE "pull_requests" ADD COLUMN "diff_job_id" text;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "diff_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_diff_job_id_check" CHECK ("pull_requests"."diff_job_id" ~ '^diff-[0-9a-f]{32}$');--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_diff_job_check" CHECK (("pull_requests"."diff_job_id" is null) = ("pull_requests"."diff_queued_at" is null));