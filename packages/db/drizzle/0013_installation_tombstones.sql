CREATE TABLE "deleted_installations" (
	"github_installation_id" bigint PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "removed_installation_repos" (
	"github_installation_id" bigint NOT NULL,
	"provider_repo_id" bigint NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "removed_installation_repos_github_installation_id_provider_repo_id_pk" PRIMARY KEY("github_installation_id","provider_repo_id")
);
