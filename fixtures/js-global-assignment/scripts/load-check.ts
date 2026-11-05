const base = new URL(process.env.LOAD_BASE_URL!);

export async function check(slug: string): Promise<boolean> {
  const ready = await fetch(new URL("/api/health/ready", base));
  const booked = await fetch(new URL(`/api/bookings/${slug}`, base), { method: "POST" });
  return ready.ok && booked.ok;
}
