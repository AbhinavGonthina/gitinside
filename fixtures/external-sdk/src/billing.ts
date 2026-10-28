import { PutObjectCommand } from "@aws-sdk/client-s3";
import { resend, s3, stripe } from "./clients";

/** A Stripe SDK call and a literal fetch to Stripe's host share one external node. */
export async function charge(customer: string, amount: number) {
  await stripe.paymentIntents.create({ customer, amount, currency: "usd" });
  await fetch("https://api.stripe.com:443/v1/balance");
}

export async function sendReceipt(to: string) {
  await resend.emails.send({ from: "billing@example.com", to, subject: "Receipt", html: "" });
}

/** `new PutObjectCommand()` builds a value; only `s3.send()` is a request. */
export async function archive(key: string, body: string) {
  await s3.send(new PutObjectCommand({ Bucket: "receipts", Key: key, Body: body }));
}

/** Runs locally: listed in Stripe's `local` methods, so no edge. */
export function verify(payload: string, signature: string, secret: string) {
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
