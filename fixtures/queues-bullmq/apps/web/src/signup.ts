import { emailQueue, tenantQueue } from "./queues";

export async function signup(email: string) {
  await emailQueue.add("welcome", { email });
  await tenantQueue.add("provision", { email });
}
