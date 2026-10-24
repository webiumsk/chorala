import { env } from '@chorala/config'
import { client, db, sql, users } from '@chorala/db'
import { createAuth } from '../auth.ts'

/**
 * Provision a fresh installation. Never reset, delete or replace existing accounts.
 */
async function main() {
  const email = env.CHORALA_BOOTSTRAP_EMAIL
  const password = env.CHORALA_BOOTSTRAP_PASSWORD
  const name = env.CHORALA_BOOTSTRAP_NAME || 'Administrator'
  if (!email || !password) throw new Error('Configure the initial administrator credentials')
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('chorala-bootstrap', 0))`)
    const existing = await tx.select({ id: users.id }).from(users).limit(1)
    if (existing.length)
      throw new Error('Accounts already exist; use invitations or password recovery')
    await createAuth({ allowRegistration: true }).api.signUpEmail({
      body: { email, password, name },
    })
  })
  console.log('Initial administrator created. Remove the bootstrap password from the environment.')
}

main()
  .catch(() => {
    // Provider errors can contain request data. Do not print credentials or raw errors.
    console.error(
      'Administrator bootstrap refused or failed. Check configuration and use a fresh installation; existing accounts were not reset.',
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await client.end()
  })
