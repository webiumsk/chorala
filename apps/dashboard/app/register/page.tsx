import { env } from '@chorala/config'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { RegisterForm } from './register-form'

// Deployment policy is injected at runtime, not baked into the Docker image.
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Create your account - Chorala' }

export default function RegisterPage() {
  if (env.CHORALA_DEPLOYMENT !== 'cloud' && !env.CHORALA_ALLOW_SIGNUP) redirect('/login')
  return (
    <AuthShell
      title="Create your account"
      subtitle="Start collecting feedback in minutes."
      footer={
        <p className="mt-5 text-center text-xs text-ink-faint">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <RegisterForm />
    </AuthShell>
  )
}
