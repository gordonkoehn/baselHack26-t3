import type { NextConfig } from "next";

// Where the FastAPI backend lives. Local: uvicorn on :8000. Vercel: set BACKEND_URL to the backend deployment.
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  experimental: {
    // Next's own rewrite proxy gives up after 30 s, shorter than creating a persona takes. Match
    // Vercel's 120 s, which applies when deployed; backend/app/readiness.py stays below both.
    proxyTimeout: 120_000,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
