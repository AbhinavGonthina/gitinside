import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
const prisma = new PrismaClient();

/** Credentials in a literal URL: the external node keeps only the host. */
export async function pushToPartner() {
  await fetch("https://gi_fake_urluser:gi_fake_urlpass_c05d@api.partner.example/v1/sync");
}

/** A hardcoded key passed alongside a runtime URL: the URL is unresolved. */
export async function notify(target: string) {
  await fetch(target, { headers: { Authorization: "Bearer gi_fake_bearer_token_f7a1" } });
}

/** A hardcoded key in a request to a resolved route-less path. */
export async function report() {
  await fetch("/internal/report", { headers: { "x-api-key": "gi_fake_header_key_3b8c" } });
}

/** A hardcoded key in the query of a runtime URL: the path is shown, the query isn't. */
export async function items(target: string) {
  await fetch(`${target}/v2/items?api_key=gi_fake_query_key_9d4e&page=${1}&sig=gi_fake_sig_d2c0`);
}

/** A wrapper whose second parameter is a token, not part of the URL. */
export function signed(url: string, token: string) {
  return fetch(url, { headers: { Authorization: token } });
}

export function pull(target: string) {
  return signed(target, "gi_fake_wrapper_token_ab12");
}

export async function countAccounts() {
  await stripe.customers.list({ limit: 1 });
  return prisma.account.count();
}
