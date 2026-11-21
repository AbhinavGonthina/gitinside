import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

export async function chargeOrder(orderId: number, amount: number) {
  await stripe.paymentIntents.create({ amount, currency: "usd", metadata: { orderId } });
}

export async function refundOrder(orderId: number) {
  await stripe.refunds.create({ metadata: { orderId } });
}
