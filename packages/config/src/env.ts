import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { resolveAdminHosts } from './hosts.ts'

/** Walk up from `start` to find the monorepo root (the dir holding pnpm-workspace.yaml). */
function findRepoRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

let dotenvLoaded = false
function ensureDotenv(): void {
  if (dotenvLoaded) return
  dotenvLoaded = true
  const root = findRepoRoot(process.cwd())
  loadDotenv(root ? { path: resolve(root, '.env'), quiet: true } : { quiet: true })
}

export const envSchema = z
  .object({
    // --- Deployment ---
    CHORALA_DEPLOYMENT: z.enum(['selfhost', 'cloud']).default('selfhost'),
    CHORALA_PUBLIC_URL: z.url().default('http://localhost:3015'),
    CHORALA_ADMIN_HOSTS: z.string().default(''),
    CHORALA_API_URL: z.url().default('http://localhost:8787'),
    CHORALA_API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // --- Database (required) ---
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    CHORALA_DB_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{32,}$/,
          'Use a random URL-safe database password of at least 32 characters',
        )
        .optional(),
    ),

    // --- Redis ---
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    // --- Auth ---
    CHORALA_AUTH_SECRET: z.string().min(32, 'CHORALA_AUTH_SECRET must be at least 32 characters'),
    CHORALA_ALLOW_SIGNUP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    CHORALA_BOOTSTRAP_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.email().optional(),
    ),
    CHORALA_BOOTSTRAP_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(16).max(128).optional(),
    ),
    CHORALA_BOOTSTRAP_NAME: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).max(200).optional(),
    ),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    // --- AI (optional; degrades to disabled) ---
    CHORALA_AI_PROVIDER: z.enum(['ollama', 'openai', 'anthropic', 'none']).default('ollama'),
    CHORALA_AI_BASE_URL: z.url().default('http://localhost:11434'),
    CHORALA_AI_API_KEY: z.string().optional(),
    CHORALA_AI_CHAT_MODEL: z.string().default('llama3.1:8b'),
    CHORALA_AI_EMBED_MODEL: z.string().default('nomic-embed-text'),
    CHORALA_AI_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.86),

    // --- Email (optional) ---
    CHORALA_EMAIL_TRANSPORT: z.enum(['smtp', 'resend', 'none']).default('smtp'),
    CHORALA_EMAIL_FROM: z.string().default('feedback@example.com'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    // --- Billing (cloud only) ---
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PRICE_STARTER: z.string().optional(),
    STRIPE_PRICE_PRO: z.string().optional(),

    // --- Widget / public API ---
    CHORALA_WIDGET_CDN_URL: z.url().default('http://localhost:8787/widget.js'),
    CHORALA_RATE_LIMIT_PUBLIC: z.coerce.number().int().positive().default(60),

    // --- Attachments (bug-report screenshots) ---
    // Absolute, shared path: API writes, dashboard reads. Must be reachable by both apps.
    CHORALA_UPLOAD_DIR: z
      .string()
      .refine(isAbsolute, 'CHORALA_UPLOAD_DIR must be an absolute path')
      .default('/tmp/chorala-uploads'),
    // Per-file ceiling (5 MB) and per-project storage quota (1 GB) — metered, not inlined.
    CHORALA_ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .default(5_000_000),
    CHORALA_ATTACHMENT_QUOTA_BYTES: z.coerce.number().int().positive().default(1_000_000_000),
  })
  .superRefine((val, ctx) => {
    try {
      resolveAdminHosts(val.CHORALA_PUBLIC_URL, val.CHORALA_ADMIN_HOSTS)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHORALA_ADMIN_HOSTS'],
        message: error instanceof Error ? error.message : 'Invalid admin host configuration',
      })
    }
    if (
      (val.CHORALA_AI_PROVIDER === 'openai' || val.CHORALA_AI_PROVIDER === 'anthropic') &&
      !val.CHORALA_AI_API_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHORALA_AI_API_KEY'],
        message: `CHORALA_AI_API_KEY is required when CHORALA_AI_PROVIDER=${val.CHORALA_AI_PROVIDER}`,
      })
    }
  })

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

/** Validate process.env (loading the repo-root .env first). Throws a readable error on failure. */
export function loadEnv(): Env {
  if (cached) return cached
  ensureDotenv()
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `\n✗ Invalid environment configuration:\n${issues}\n\nFix your .env (see .env.example for the full list).\n`,
    )
  }
  cached = parsed.data
  return cached
}

/** Reset the validation cache — used by tests. */
export function resetEnvCache(): void {
  cached = null
  dotenvLoaded = false
}

/** Lazily-validated env singleton. Access a key to trigger validation on first use. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return loadEnv()[prop as keyof Env]
  },
  has(_target, prop: string) {
    return prop in loadEnv()
  },
})
