import { randomBytes } from 'node:crypto'
import { env } from '@chorala/config'
import { db, newId, schema } from '@chorala/db'
import { resetPasswordEmail, sendEmail, verifyEmail } from '@chorala/email'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {}
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  }
}
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  }
}

/** Only the operator CLI can opt into registration independently of deployment policy. */
export function createAuth(options: { allowRegistration?: boolean } = {}) {
  const registrationAllowed =
    options.allowRegistration === true ||
    env.CHORALA_DEPLOYMENT === 'cloud' ||
    env.CHORALA_ALLOW_SIGNUP
  return betterAuth({
    secret: env.CHORALA_AUTH_SECRET,
    baseURL: env.CHORALA_API_URL,
    basePath: '/api/v1/auth',
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !registrationAllowed,
      autoSignIn: true,
      sendResetPassword: async ({ user, token }) => {
        const url = `${env.CHORALA_PUBLIC_URL}/reset?token=${token}`
        try {
          await sendEmail({ to: user.email, ...resetPasswordEmail(url) })
        } catch (e) {
          console.error('[auth] reset email failed:', (e as Error).message)
        }
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, token }) => {
        const cb = encodeURIComponent('/login?verified=1')
        const url = `${env.CHORALA_PUBLIC_URL}/api/v1/auth/verify-email?token=${token}&callbackURL=${cb}`
        try {
          await sendEmail({ to: user.email, ...verifyEmail(url) })
        } catch (e) {
          console.error('[auth] verification email failed:', (e as Error).message)
        }
      },
    },
    // New signups get a personal org (owner) so the dashboard always has a home to land in.
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!registrationAllowed)
              throw new APIError('FORBIDDEN', { message: 'Registration is disabled' })
          },
          after: async (user: { id: string; email: string; name?: string }) => {
            const seed = (user.name || user.email.split('@')[0] || 'workspace')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 24)
            const slug = `${seed || 'workspace'}-${randomBytes(3).toString('hex')}`
            const orgId = newId('organization')
            await db.insert(schema.organizations).values({
              id: orgId,
              slug,
              name: user.name ? `${user.name}'s workspace` : 'My workspace',
              plan: 'free',
              defaultLocale: 'en',
              locales: ['en'],
              settings: {},
            })
            await db.insert(schema.members).values({ orgId, userId: user.id, role: 'owner' })
          },
        },
      },
    },
    // Trust this installation's configured origins, never upstream operators.
    trustedOrigins: [
      ...new Set([new URL(env.CHORALA_PUBLIC_URL).origin, new URL(env.CHORALA_API_URL).origin]),
    ],
    // Same scheme decision as the dashboard (both read CHORALA_PUBLIC_URL) so the session
    // cookie name/flags match across the api (:8787) and dashboard (:3015) backends.
    advanced: { useSecureCookies: env.CHORALA_PUBLIC_URL.startsWith('https://') },
    socialProviders,
  })
}

/** Better Auth admin authentication, with public registration disabled by default. */
export const auth = createAuth()

export type Auth = typeof auth
