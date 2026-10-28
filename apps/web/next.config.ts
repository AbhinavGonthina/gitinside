import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/csp";

const config: NextConfig = {
  // Don't advertise the framework version.
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default config;
