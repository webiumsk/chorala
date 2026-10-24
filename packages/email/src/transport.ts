import { env } from '@chorala/config'
import nodemailer from 'nodemailer'
import type { Email } from './templates.ts'

export type SendArgs = Email & { to: string }

export interface EmailTransport {
  readonly name: string
  readonly enabled: boolean
  send(args: SendArgs): Promise<void>
}

/** No-op transport logs configuration state without exposing message contents or recipients. */
class NoopTransport implements EmailTransport {
  readonly name = 'none'
  readonly enabled = false
  async send(_args: SendArgs) {
    console.warn('[email] No email transport configured; message skipped.')
  }
}

class SmtpTransport implements EmailTransport {
  readonly name = 'smtp'
  readonly enabled = true
  private transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  async send(args: SendArgs) {
    await this.transporter.sendMail({
      from: env.CHORALA_EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    })
  }
}

class ResendTransport implements EmailTransport {
  readonly name = 'resend'
  readonly enabled = true
  async send(args: SendArgs) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.CHORALA_EMAIL_FROM,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    })
    if (!res.ok) throw new Error(`Resend failed: ${res.status}`)
  }
}

let transport: EmailTransport | null = null

export function getTransport(): EmailTransport {
  if (transport) return transport
  switch (env.CHORALA_EMAIL_TRANSPORT) {
    case 'smtp':
      transport = env.SMTP_HOST ? new SmtpTransport() : new NoopTransport()
      break
    case 'resend':
      transport = env.RESEND_API_KEY ? new ResendTransport() : new NoopTransport()
      break
    default:
      transport = new NoopTransport()
  }
  return transport
}

export async function sendEmail(args: SendArgs): Promise<void> {
  await getTransport().send(args)
}
