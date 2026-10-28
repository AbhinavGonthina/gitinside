import { S3Client } from "@aws-sdk/client-s3";
import { Resend } from "resend";
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
export const resend = new Resend(process.env.RESEND_API_KEY);
export const s3 = new S3Client({ region: "us-east-1" });
