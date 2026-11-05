// Outside web/, so web/jsconfig.json's alias doesn't apply: this import stays unresolved.
import client from "@/lib/client";

export async function seed() {
  await client.post("/notes", { title: "first" });
}
