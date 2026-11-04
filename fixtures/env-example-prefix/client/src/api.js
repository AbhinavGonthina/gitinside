const BASE = import.meta.env.VITE_SERVER_BASE_URL;
const ADMIN = import.meta.env.VITE_ADMIN_API_URL || "http://localhost:5000/api";
const PAYMENTS = import.meta.env.VITE_PAYMENTS_API_URL;

/** `{env:VITE_SERVER_BASE_URL}/auth/login`: `/api` comes from `client/.env.example`. */
export async function signIn(credentials) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  return res.json();
}

/** Same base, a hole matching `:blogId`. */
export async function getBlog(blogId) {
  const res = await fetch(`${BASE}/blog/${blogId}`);
  return res.json();
}

/** The code's fallback already holds `/api`: the example's `/api` isn't added twice. */
export async function getStats() {
  const res = await fetch(`${ADMIN}/stats`);
  return res.json();
}

/** The example gives this base no path, so `/checkout` matches no route: unresolved. */
export async function checkout(cart) {
  await fetch(`${PAYMENTS}/checkout`, { method: "POST", body: JSON.stringify(cart) });
}
