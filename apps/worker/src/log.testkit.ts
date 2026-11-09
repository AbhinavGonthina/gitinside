/** A database host as a driver's message would name it; logs must never carry it (M8.10e2b). */
export const DB_HOST = "ep-quiet-db-123.us-east-2.aws.neon.tech";

/** A refused database connection the way postgres.js throws it: a host in the message, a code. */
export function dbDown(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${DB_HOST}:5432`), {
    code: "ECONNREFUSED",
  });
}
