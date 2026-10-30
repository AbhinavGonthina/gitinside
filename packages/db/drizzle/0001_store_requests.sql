CREATE TABLE "store_requests" (
	"month_start" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "store_requests_month_start_source_pk" PRIMARY KEY("month_start","source"),
	CONSTRAINT "store_requests_source_check" CHECK ("store_requests"."source" in ('worker', 'web')),
	CONSTRAINT "store_requests_count_check" CHECK ("store_requests"."count" >= 0)
);
