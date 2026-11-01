ALTER TABLE "repos" ADD COLUMN "analysis_claim_sha" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "analysis_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_analysis_claim_sha_check" CHECK ("repos"."analysis_claim_sha" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_analysis_claim_check" CHECK (("repos"."analysis_claim_sha" is null) = ("repos"."analysis_claimed_at" is null));