import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { env } from '@chorala/config'
import { and, attachments, db, eq, inArray, isNull, newId, sql } from '@chorala/db'
import type { CreateAttachmentInput } from '@chorala/types'
import sharp from 'sharp'
import type { AuthContext } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s
const FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MAX_IMAGE_PIXELS = 16_777_216

/** Decode a `data:<mime>;base64,<payload>` URL into a typed buffer; reject anything unexpected. */
async function decodeDataUrl(dataUrl: string) {
  // Check encoded length before regex capture, allocation or image decoding.
  const maxEncoded = 4 * Math.ceil(env.CHORALA_ATTACHMENT_MAX_BYTES / 3)
  if (dataUrl.length > maxEncoded + 128) throw badRequest('Attachment exceeds the size limit')
  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) throw badRequest('Malformed data URL')
  const [, rawMime, payload = ''] = m
  const mimeType = (rawMime ?? '').toLowerCase()
  if (!FORMATS[mimeType]) throw badRequest('Unsupported attachment type')
  if (
    !payload ||
    payload.length > maxEncoded ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  ) {
    throw badRequest('Invalid or oversized attachment encoding')
  }
  const bytes = Buffer.from(payload, 'base64')
  if (
    !bytes.length ||
    bytes.length > env.CHORALA_ATTACHMENT_MAX_BYTES ||
    bytes.toString('base64') !== payload
  ) {
    throw badRequest('Invalid or oversized attachment')
  }
  // Reject unsupported formats before entering a native decoder (notably SVG).
  const headers: Record<string, boolean> = {
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'image/gif': ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)),
    'image/webp':
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP',
  }
  if (!headers[mimeType]) throw badRequest('Attachment type does not match its image header')
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' })
    const metadata = await image.metadata()
    if (
      metadata.format !== FORMATS[mimeType] ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new Error('Image type does not match')
    }
    // Decode all pixels, rather than trusting the MIME string or a magic header.
    await image.stats()
    return { mimeType, bytes, width: metadata.width, height: metadata.height }
  } catch {
    throw badRequest('Invalid image or image dimensions exceed the limit')
  }
}

function uploadRoot() {
  return resolve(env.CHORALA_UPLOAD_DIR)
}

/** Sum of stored attachment bytes for a project — the figure the per-project quota guards. */
export async function projectStorageUsage(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
    .from(attachments)
    .where(eq(attachments.projectId, projectId))
  return Number(row?.total ?? 0)
}

/**
 * Store an uploaded attachment (public, end-user-authenticated). Bytes go to disk; a metadata
 * row is inserted unlinked (post_id null) and linked when the post is created. Enforces a
 * per-file ceiling and a per-project storage quota so a project can't be used as free storage.
 */
export async function createPublicAttachment(
  projectId: string,
  endUserId: string,
  input: CreateAttachmentInput,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw badRequest('Invalid project')
  const { mimeType, bytes, width, height } = await decodeDataUrl(input.dataUrl)
  const byteSize = bytes.byteLength
  const id = newId('attachment')
  const storageKey = join(projectId, id)
  const file = join(uploadRoot(), storageKey)
  let written = false
  try {
    return await db.transaction(async (tx) => {
      // Serialize reservations across all API replicas for this project.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`)
      const [usage] = await tx
        .select({ total: sql<number>`coalesce(sum(${attachments.byteSize}), 0)::bigint` })
        .from(attachments)
        .where(eq(attachments.projectId, projectId))
      if (Number(usage?.total ?? 0) + byteSize > env.CHORALA_ATTACHMENT_QUOTA_BYTES) {
        throw badRequest('Project attachment storage quota exceeded')
      }
      await mkdir(join(uploadRoot(), projectId), { recursive: true })
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      written = true
      const [row] = await tx
        .insert(attachments)
        .values({
          id,
          projectId,
          endUserId,
          kind: input.kind,
          mimeType,
          byteSize,
          width,
          height,
          storageKey,
        })
        .returning({
          id: attachments.id,
          kind: attachments.kind,
          mimeType: attachments.mimeType,
          byteSize: attachments.byteSize,
          width: attachments.width,
          height: attachments.height,
        })
      if (!row) throw badRequest('Failed to store attachment')
      return row
    })
  } catch (error) {
    if (written) await unlink(file).catch(() => undefined)
    throw error
  }
}

/**
 * Link freshly-uploaded, still-unlinked attachments to a post on creation. Scoped to the same
 * project (and end-user when known) so one tenant can't attach another's orphaned uploads.
 */
export async function linkAttachmentsToPost(
  projectId: string,
  endUserId: string | null,
  attachmentIds: string[],
  postId: string,
) {
  if (attachmentIds.length === 0) return
  const ownership = endUserId ? eq(attachments.endUserId, endUserId) : sql`true`
  await db
    .update(attachments)
    .set({ postId })
    .where(
      and(
        inArray(attachments.id, attachmentIds),
        eq(attachments.projectId, projectId),
        isNull(attachments.postId),
        ownership,
      ),
    )
}

const attachmentColumns = {
  id: attachments.id,
  projectId: attachments.projectId,
  postId: attachments.postId,
  kind: attachments.kind,
  mimeType: attachments.mimeType,
  byteSize: attachments.byteSize,
  width: attachments.width,
  height: attachments.height,
  createdAt: attachments.createdAt,
  updatedAt: attachments.updatedAt,
}

/** Attachment metadata for a post (admin) — never includes the raw bytes. */
export async function listAttachmentsForPost(ctx: AuthContext, projectId: string, postId: string) {
  await getProject(ctx, projectId)
  return db
    .select(attachmentColumns)
    .from(attachments)
    .where(and(eq(attachments.projectId, projectId), eq(attachments.postId, postId)))
}

/** Read an attachment's bytes for admin display (the dashboard streams these). */
export async function readAttachment(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select({ mimeType: attachments.mimeType, storageKey: attachments.storageKey })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.projectId, projectId)))
  if (!row) throw notFound('Attachment')
  const bytes = await readFile(join(uploadRoot(), row.storageKey))
  return { mimeType: row.mimeType, bytes }
}
