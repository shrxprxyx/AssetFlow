import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // BullMQ loads its Lua scripts from disk at runtime, so it must stay a plain
  // Node module instead of being bundled into the server build.
  serverExternalPackages: ["bullmq", "ioredis"],
};

export default nextConfig;