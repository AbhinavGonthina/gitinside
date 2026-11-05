export const siteURL = process.env.PUBLIC_APP_URL!;

export function readiness() {
  return fetch(`${siteURL}/api/health/ready`);
}
