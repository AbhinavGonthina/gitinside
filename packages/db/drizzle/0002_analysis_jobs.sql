ALTER TABLE "analyses" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "queued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "analyses" SET "queued_at" = "created_at";--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "progress" jsonb;--> statement-breakpoint
CREATE INDEX "analyses_job_id_idx" ON "analyses" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "analyses_queued_idx" ON "analyses" USING btree ("queued_at","id") WHERE "analyses"."status" = 'queued';--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_job_id_check" CHECK ("analyses"."job_id" ~ '^analyze-[0-9a-f]{32}$');--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_attempts_check" CHECK ("analyses"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_progress_check" CHECK ("analyses"."progress" is null or "analyses"."status" = 'running');