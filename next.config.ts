import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shell of /ledger is prerendered and the rows stream in when the query
  // answers. That is what makes a slow query visible as a hole in the page
  // rather than as a blank screen, and what the browser bench measures.
  cacheComponents: true,
};

export default nextConfig;
