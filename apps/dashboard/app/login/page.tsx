import { env } from '@chorala/config'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/session'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  const user = await getSessionUser()
  if (user) redirect('/admin')
  const allowSignup = env.CHORALA_DEPLOYMENT === 'cloud' || env.CHORALA_ALLOW_SIGNUP

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      {/* oversized decorative wordmark */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 bottom-0 select-none font-display text-[34vw] leading-none text-ink/[0.035]"
      >
        Chorala
      </span>

      <div className="relative w-full max-w-sm rise">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent font-display text-2xl text-white shadow-[0_12px_28px_-10px_rgba(217,81,42,0.9)]">
            C
          </div>
          <h1 className="font-display text-[26px] tracking-[-0.02em]">Welcome back</h1>
          <p className="mt-1 text-sm text-ink-soft">Sign in to triage your feedback.</p>
        </div>
        <LoginForm />
        <div className="mt-4 flex items-center justify-between text-xs">
          {allowSignup && (
            <Link href="/register" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          )}
          <Link href="/forgot" className="text-ink-soft transition hover:text-ink">
            Forgot password?
          </Link>
        </div>
      </div>
    </main>
  )
}
