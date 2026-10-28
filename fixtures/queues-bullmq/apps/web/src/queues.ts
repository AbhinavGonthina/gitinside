import { Queue } from "bullmq";

const connection = { host: "localhost", port: 6379 };

export const emailQueue = new Queue("email", { connection });

/** The name is only known at runtime: DYNAMIC_NAME, not a guess. */
export const tenantQueue = new Queue(process.env.TENANT_QUEUE ?? "", { connection });
