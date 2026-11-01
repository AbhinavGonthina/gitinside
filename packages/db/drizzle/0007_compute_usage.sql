CREATE TABLE "compute_usage" (
	"month_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"instance_ms" bigint DEFAULT 0 NOT NULL,
	"run_requests" integer DEFAULT 0 NOT NULL,
	"task_operations" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "compute_usage_instance_ms_check" CHECK ("compute_usage"."instance_ms" >= 0),
	CONSTRAINT "compute_usage_run_requests_check" CHECK ("compute_usage"."run_requests" >= 0),
	CONSTRAINT "compute_usage_task_operations_check" CHECK ("compute_usage"."task_operations" >= 0)
);
