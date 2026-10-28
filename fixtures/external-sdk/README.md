# external-sdk

Tests: allowlisted SDK clients built in one file and used in another. `stripe.paymentIntents.create()` and `fetch("https://api.stripe.com:443/…")` share `external:ext/api.stripe.com`; `resend.emails.send()` ⇒ `api.resend.com`; `s3.send()` ⇒ the S3 endpoint. `new PutObjectCommand()` and `stripe.webhooks.constructEvent()` run locally and draw no edge.
