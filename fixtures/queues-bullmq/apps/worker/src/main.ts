import { Worker, type Job } from "bullmq";

export async function sendEmail(job: Job<{ email: string }>) {
  return job.data.email;
}

new Worker("email", sendEmail, { connection: { host: "localhost", port: 6379 } });
