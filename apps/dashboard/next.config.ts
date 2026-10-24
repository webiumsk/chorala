import type { NextConfig } from 'next'

const config: NextConfig = {
  // Internal workspace packages export TS source — let Next transpile them.
  transpilePackages: ['@chorala/core', '@chorala/db', '@chorala/config', '@chorala/types'],
  outputFileTracingRoot: undefined,
  eslint: { ignoreDuringBuilds: true },
  // postgres.js / ioredis must stay server-only.
  serverExternalPackages: ['postgres', 'ioredis', 'better-auth', 'bullmq', 'stripe', 'sharp'],
}

export default config
