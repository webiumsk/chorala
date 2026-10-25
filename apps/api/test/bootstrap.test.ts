import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accounts, client, db, eq, members, SEED_ADMIN, users } from '@chorala/db'
import { afterAll, expect, test } from 'vitest'

afterAll(async () => {
  await client.end()
})

test('bootstrap refuses an occupied installation without changing accounts or logging credentials', async () => {
  expect(process.env.NODE_ENV).toBe('test')
  const snapshot = async () => {
    const [user] = await db.select().from(users).where(eq(users.email, SEED_ADMIN.email))
    if (!user) throw new Error('Synthetic seed user missing')
    return {
      user,
      accounts: await db
        .select({ id: accounts.id, userId: accounts.userId, providerId: accounts.providerId })
        .from(accounts)
        .where(eq(accounts.userId, user.id)),
      memberships: await db.select().from(members).where(eq(members.userId, user.id)),
    }
  }
  const before = await snapshot()
  const password = 'synthetic-only-bootstrap-retry-password'
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/seed-admin.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      CHORALA_BOOTSTRAP_EMAIL: 'refused@example.test',
      CHORALA_BOOTSTRAP_PASSWORD: password,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('existing accounts were not reset')
  expect(result.stdout + result.stderr).not.toContain(password)
  expect(await snapshot()).toEqual(before)
  expect(
    await db.select({ id: users.id }).from(users).where(eq(users.email, 'refused@example.test')),
  ).toHaveLength(0)
}, 60_000)
