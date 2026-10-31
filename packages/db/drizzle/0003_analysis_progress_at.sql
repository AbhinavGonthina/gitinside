ALTER TABLE "analyses" ADD COLUMN "progress_at" timestamp with time zone;--> statement-breakpoint
UPDATE "analyses" SET "progress_at" = now() WHERE "progress" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_progress_at_check" CHECK (("analyses"."progress" is null) = ("analyses"."progress_at" is null));