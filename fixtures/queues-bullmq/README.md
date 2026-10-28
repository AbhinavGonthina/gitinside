# queues-bullmq

Tests: a BullMQ producer and worker in different services meeting at one queue. `@q/web`'s `signup` adds to `new Queue("email")` (exported from another file) ⇒ `publishes` to `queue:infra/redis#email`; `@q/worker`'s `new Worker("email", sendEmail)` ⇒ `consumes` from `sendEmail`. A queue named from `process.env` ⇒ an `unresolved` node with `DYNAMIC_NAME`.
