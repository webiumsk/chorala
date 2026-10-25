import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { env, resetEnvCache } from '@chorala/config'
import { client, db, eq, members, newId, organizations, users } from '@chorala/db'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import type { AuthContext } from '../src/context.ts'
import * as endUsers from '../src/services/endUsers.ts'
import * as projects from '../src/services/projects.ts'
import * as storage from '../src/services/storage.ts'

let ctx: AuthContext
let orgId: string
let userId: string
let png: Buffer
const projectIds: string[] = []
const originalQuota = process.env.CHORALA_ATTACHMENT_QUOTA_BYTES

beforeAll(async () => {
  orgId = newId('organization')
  userId = newId('user')
  const slug = `upload-${randomUUID()}`
  await db.insert(organizations).values({ id: orgId, slug, name: 'Synthetic upload tests' })
  await db
    .insert(users)
    .values({ id: userId, email: `${slug}@example.test`, name: 'Synthetic owner' })
  const memberId = newId('member')
  await db.insert(members).values({ id: memberId, orgId, userId, role: 'owner' })
  ctx = { kind: 'session', orgId, userId, memberId, role: 'owner' }
  png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#abcdef' } })
    .png()
    .toBuffer()
})

afterEach(() => {
  if (originalQuota === undefined) delete process.env.CHORALA_ATTACHMENT_QUOTA_BYTES
  else process.env.CHORALA_ATTACHMENT_QUOTA_BYTES = originalQuota
  resetEnvCache()
})

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId))
  await db.delete(users).where(eq(users.id, userId))
  for (const id of projectIds)
    await rm(join(env.CHORALA_UPLOAD_DIR, id), { recursive: true, force: true })
  await client.end()
})

async function fixture() {
  const project = await projects.createProject(ctx, {
    name: 'Synthetic attachments',
    slug: randomUUID(),
    isPublic: true,
    allowedOrigins: [],
  })
  projectIds.push(project.id)
  const user = await endUsers.createAnonymous(project.id, 'en')
  return { project, user }
}

test('rejects active content, MIME spoofing, invalid base64 and oversized encoded input before storage', async () => {
  const { project, user } = await fixture()
  for (const dataUrl of [
    `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
    `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    `data:image/jpeg;base64,${png.toString('base64')}`,
    'data:image/png;base64,%%%%',
    `data:image/png;base64,${'A'.repeat(4 * Math.ceil(env.CHORALA_ATTACHMENT_MAX_BYTES / 3) + 4)}`,
  ]) {
    await expect(
      storage.createPublicAttachment(project.id, user.id, { dataUrl, kind: 'screenshot' }),
    ).rejects.toThrow()
  }
  expect(await storage.projectStorageUsage(project.id)).toBe(0)
})

test('concurrent uploads cannot exceed the same project quota', async () => {
  const { project, user } = await fixture()
  process.env.CHORALA_ATTACHMENT_QUOTA_BYTES = String(png.length)
  resetEnvCache()
  const input = {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    kind: 'screenshot' as const,
  }
  const results = await Promise.allSettled([
    storage.createPublicAttachment(project.id, user.id, input),
    storage.createPublicAttachment(project.id, user.id, input),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  expect(await storage.projectStorageUsage(project.id)).toBe(png.length)
  expect(await readdir(join(env.CHORALA_UPLOAD_DIR, project.id))).toHaveLength(1)
})

test('rejects a valid multi-frame GIF before persisting any attachment', async () => {
  const { project, user } = await fixture()
  const encoded =
    'R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAAh+QQAAAAAACwAAAAAAQABAAACAUQAOw=='
  expect((await sharp(Buffer.from(encoded, 'base64')).metadata()).pages).toBe(2)
  await expect(
    storage.createPublicAttachment(project.id, user.id, {
      dataUrl: `data:image/gif;base64,${encoded}`,
      kind: 'screenshot',
    }),
  ).rejects.toThrow()
  expect(await storage.projectStorageUsage(project.id)).toBe(0)
})

test('a database failure removes the file and does not consume quota', async () => {
  const { project } = await fixture()
  await expect(
    storage.createPublicAttachment(project.id, 'eu_nonexistent', {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      kind: 'screenshot',
    }),
  ).rejects.toThrow()
  expect(await storage.projectStorageUsage(project.id)).toBe(0)
  expect(await readdir(join(env.CHORALA_UPLOAD_DIR, project.id))).toHaveLength(0)
})
