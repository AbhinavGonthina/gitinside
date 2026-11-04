import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({ enabled: false });

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/shop",
  async rewrites() {
    return {
      beforeFiles: [{ source: "/legacy/items", destination: "/api/items" }],
      afterFiles: [
        { source: "/backend/:path*", destination: "http://localhost:4000/:path*" },
        { source: "/weather/:city", destination: "https://api.weather.example.com/v1/:city" },
        { source: "/status", destination: "https://status.example.com/", basePath: false },
      ],
      fallback: [{ source: "/:path*", destination: "http://localhost:4000/:path*" }],
    };
  },
};

export default withBundleAnalyzer(nextConfig);
