ALTER TABLE "installations" ADD COLUMN "account_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "account_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_account_type_check" CHECK ("installations"."account_type" in ('User', 'Organization'));