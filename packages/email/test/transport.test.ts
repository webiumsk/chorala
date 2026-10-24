import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, test } from 'node:test'
import { resetEnvCache } from '@chorala/config'

const configurationKeys = [
  'NODE_ENV',
  'DATABASE_URL',
  'CHORALA_AUTH_SECRET',
  'CHORALA_EMAIL_TRANSPORT',
  'CHORALA_EMAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'RESEND_API_KEY',
] as const
const original = new Map(configurationKeys.map((key) => [key, process.env[key]]))
let importSequence = 0

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
})

async function transport(
  configuration: Partial<Record<(typeof configurationKeys)[number], string>>,
) {
  for (const key of configurationKeys) delete process.env[key]
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:9/unused_email_test_database',
    CHORALA_AUTH_SECRET: 'synthetic_email_test_secret_at_least_32_characters',
    CHORALA_EMAIL_FROM: 'Feedback Bot <feedback@example.test>',
    ...configuration,
  })
  resetEnvCache()
  const url = new URL('../src/transport.ts', import.meta.url)
  url.searchParams.set('test', String(importSequence++))
  return import(url.href) as Promise<typeof import('../src/transport.ts')>
}

type SmtpOptions = { requireAuth?: boolean; rejectRecipient?: boolean }
type SmtpCapture = {
  connections: number
  authCommands: number
  authenticated: boolean
  envelopeFrom: string[]
  envelopeTo: string[]
  messages: string[]
}
const credentials = { user: 'synthetic_smtp_user', pass: 'synthetic_smtp_password_for_tests' }

/** A loopback-only SMTP fixture. Nothing is forwarded or delivered outside this process. */
async function withSmtp(
  options: SmtpOptions,
  run: (port: number, capture: SmtpCapture) => Promise<void>,
) {
  const capture: SmtpCapture = {
    connections: 0,
    authCommands: 0,
    authenticated: false,
    envelopeFrom: [],
    envelopeTo: [],
    messages: [],
  }
  const sockets = new Set<Socket>()
  const smtp = createServer((socket) => {
    sockets.add(socket)
    capture.connections++
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(5_000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.write('220 synthetic.example.test ESMTP fixture\r\n')
    let buffer = ''
    let data = false
    let authStage: 'plain' | 'user' | 'pass' | null = null
    let loginUser = ''
    let authenticated = false
    let acceptedRecipients = 0
    const completeAuth = (user: string, pass: string) => {
      authenticated = user === credentials.user && pass === credentials.pass
      capture.authenticated = authenticated
      socket.write(
        authenticated
          ? '235 2.7.0 Authentication successful\r\n'
          : '535 5.7.8 Authentication failed\r\n',
      )
    }
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 128 * 1024) return socket.destroy()
      while (buffer.length) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          capture.messages.push(buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.'))
          buffer = buffer.slice(end + 5)
          data = false
          socket.write('250 2.0.0 Synthetic message accepted\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (authStage) {
          const decoded = Buffer.from(line, 'base64').toString('utf8')
          if (authStage === 'plain') {
            const parts = decoded.split('\0')
            completeAuth(parts[1] ?? '', parts[2] ?? '')
            authStage = null
          } else if (authStage === 'user') {
            loginUser = decoded
            authStage = 'pass'
            socket.write('334 UGFzc3dvcmQ6\r\n')
          } else {
            completeAuth(loginUser, decoded)
            loginUser = ''
            authStage = null
          }
          continue
        }
        if (/^(EHLO|HELO) /i.test(line)) {
          socket.write(
            '250-synthetic.example.test\r\n250-PIPELINING\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 131072\r\n',
          )
        } else if (/^AUTH PLAIN(?: |$)/i.test(line)) {
          capture.authCommands++
          const encoded = line.slice('AUTH PLAIN'.length).trim()
          if (encoded) {
            const parts = Buffer.from(encoded, 'base64').toString('utf8').split('\0')
            completeAuth(parts[1] ?? '', parts[2] ?? '')
          } else {
            authStage = 'plain'
            socket.write('334 \r\n')
          }
        } else if (/^AUTH LOGIN$/i.test(line)) {
          capture.authCommands++
          authStage = 'user'
          socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (/^MAIL FROM:/i.test(line)) {
          acceptedRecipients = 0
          if (options.requireAuth && !authenticated) {
            socket.write('530 5.7.0 Authentication required\r\n')
          } else {
            capture.envelopeFrom.push(line.match(/<([^>]+)>/)?.[1] ?? '')
            socket.write('250 2.1.0 Sender accepted\r\n')
          }
        } else if (/^RCPT TO:/i.test(line)) {
          capture.envelopeTo.push(line.match(/<([^>]+)>/)?.[1] ?? '')
          if (!options.rejectRecipient) acceptedRecipients++
          socket.write(
            options.rejectRecipient
              ? '550 5.1.1 Synthetic recipient rejected\r\n'
              : '250 2.1.5 Recipient accepted\r\n',
          )
        } else if (/^DATA$/i.test(line)) {
          if (acceptedRecipients > 0) {
            data = true
            socket.write('354 End with <CRLF>.<CRLF>\r\n')
          } else {
            socket.write('554 5.5.1 No valid recipients\r\n')
          }
        } else if (/^QUIT$/i.test(line)) {
          socket.end('221 2.0.0 Goodbye\r\n')
        } else if (/^(RSET|NOOP)$/i.test(line)) {
          socket.write('250 2.0.0 OK\r\n')
        } else {
          socket.write('500 5.5.1 Unsupported fixture command\r\n')
        }
      }
    })
  })
  smtp.listen(0, '127.0.0.1')
  await once(smtp, 'listening')
  const address = smtp.address()
  assert(address && typeof address !== 'string')
  try {
    await run(address.port, capture)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      smtp.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

const message = {
  to: 'Recipient Name <recipient@example.test>',
  subject: 'Synthetic transport regression',
  text: 'Synthetic plain text body.',
  html: '<p>Synthetic HTML body.</p>',
}

test('SMTP preserves sender, recipient, subject and both message formats', async () => {
  await withSmtp({}, async (port, capture) => {
    const mail = await transport({
      CHORALA_EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
    })
    assert.equal(mail.getTransport().name, 'smtp')
    assert.equal(mail.getTransport().enabled, true)
    await mail.sendEmail(message)
    assert.deepEqual(capture.envelopeFrom, ['feedback@example.test'])
    assert.deepEqual(capture.envelopeTo, ['recipient@example.test'])
    assert.equal(capture.messages.length, 1)
    const mime = capture.messages[0]!
    assert.match(mime, /From: Feedback Bot <feedback@example\.test>/)
    assert.match(mime, /To: Recipient Name <recipient@example\.test>/)
    assert(mime.includes(`Subject: ${message.subject}\r\n`))
    assert(mime.includes('Content-Type: multipart/alternative;'))
    assert(mime.includes(message.text))
    assert(mime.includes(message.html))
    assert.equal(capture.authCommands, 0, 'Unconfigured SMTP credentials must not send AUTH')
  })
})

test('configured SMTP credentials authenticate through the real protocol', async () => {
  await withSmtp({ requireAuth: true }, async (port, capture) => {
    const mail = await transport({
      CHORALA_EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: credentials.user,
      SMTP_PASS: credentials.pass,
    })
    await mail.sendEmail(message)
    assert(capture.authCommands > 0, 'SMTP AUTH was not attempted')
    assert(capture.authenticated, 'SMTP AUTH did not use the configured synthetic credentials')
    assert.equal(capture.messages.length, 1)
  })
})

test('SMTP recipient rejection propagates and does not claim delivery', async () => {
  await withSmtp({ rejectRecipient: true }, async (port, capture) => {
    const mail = await transport({
      CHORALA_EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
    })
    await assert.rejects(mail.sendEmail(message), (error: unknown) => {
      assert(error instanceof Error)
      assert.equal((error as Error & { code?: string }).code, 'EENVELOPE')
      assert.equal((error as Error & { responseCode?: number }).responseCode, 550)
      return true
    })
    assert.equal(capture.messages.length, 0)
  })
})

test('disabled email neither connects nor logs recipients or message contents', async () => {
  await withSmtp({ requireAuth: true }, async (port, capture) => {
    const mail = await transport({
      CHORALA_EMAIL_TRANSPORT: 'none',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: credentials.user,
      SMTP_PASS: credentials.pass,
    })
    const logs: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      logs.push(args)
    }
    try {
      assert.equal(mail.getTransport().name, 'none')
      assert.equal(mail.getTransport().enabled, false)
      await mail.sendEmail(message)
    } finally {
      console.warn = warn
    }
    assert.equal(capture.connections, 0)
    assert.deepEqual(logs, [['[email] No email transport configured; message skipped.']])
    const output = JSON.stringify(logs)
    for (const value of [
      message.to,
      message.subject,
      message.text,
      message.html,
      credentials.user,
      credentials.pass,
    ]) {
      assert(
        !output.includes(value),
        'Disabled email exposed synthetic private message information',
      )
    }
  })
})
