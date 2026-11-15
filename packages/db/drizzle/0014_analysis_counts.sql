CREATE TABLE "analysis_counts" (
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"services" integer NOT NULL,
	"files" integer NOT NULL,
	"nodes" integer NOT NULL,
	"edges" integer NOT NULL,
	"unresolved" integer NOT NULL,
	"broken" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_counts_repo_id_sha_analyzer_version_pk" PRIMARY KEY("repo_id","sha","analyzer_version"),
	CONSTRAINT "analysis_counts_sha_check" CHECK ("analysis_counts"."sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "analysis_counts_counts_check" CHECK ("analysis_counts"."services" >= 0 and "analysis_counts"."files" >= 0 and "analysis_counts"."nodes" >= 0 and "analysis_counts"."edges" >= 0 and "analysis_counts"."unresolved" >= 0 and "analysis_counts"."broken" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analysis_counts" ADD CONSTRAINT "analysis_counts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;