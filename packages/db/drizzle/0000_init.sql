CREATE TYPE "public"."analysis_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."repo_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "access_cache" (
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"allowed" boolean NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_cache_user_id_repo_id_pk" PRIMARY KEY("user_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"status" "analysis_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"stats" jsonb,
	"snapshot_key" text,
	"analyzer_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "analyses_repo_sha_version_key" UNIQUE("repo_id","sha","analyzer_version"),
	CONSTRAINT "analyses_sha_check" CHECK ("analyses"."sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "analyses_status_check" CHECK (case "analyses"."status"
        when 'queued' then "analyses"."snapshot_key" is null and "analyses"."error_code" is null and "analyses"."finished_at" is null
        when 'running' then "analyses"."snapshot_key" is null and "analyses"."error_code" is null and "analyses"."finished_at" is null and "analyses"."started_at" is not null
        when 'done' then "analyses"."snapshot_key" is not null and "analyses"."error_code" is null and "analyses"."finished_at" is not null
        when 'failed' then "analyses"."error_code" is not null and "analyses"."snapshot_key" is null and "analyses"."finished_at" is not null
      end)
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"diff_key" text,
	"broken_count" integer,
	"comment_id" bigint,
	"check_run_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_repo_number_key" UNIQUE("repo_id","number"),
	CONSTRAINT "pull_requests_number_check" CHECK ("pull_requests"."number" > 0),
	CONSTRAINT "pull_requests_base_sha_check" CHECK ("pull_requests"."base_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "pull_requests_head_sha_check" CHECK ("pull_requests"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "pull_requests_broken_count_check" CHECK ("pull_requests"."broken_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_limits_count_check" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"visibility" "repo_visibility" NOT NULL,
	"installation_id" uuid,
	"default_branch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_provider_repo_id_unique" UNIQUE("provider_repo_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
ALTER TABLE "access_cache" ADD CONSTRAINT "access_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_cache" ADD CONSTRAINT "access_cache_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_repo_created_idx" ON "analyses" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_owner_name_lower_key" ON "repos" USING btree (lower("owner"),lower("name"));--> statement-breakpoint
CREATE INDEX "repos_installation_id_idx" ON "repos" USING btree ("installation_id");