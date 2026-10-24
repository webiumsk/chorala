import { collectContext } from './context.ts'
import type {
  AttachmentRef,
  BoardsResponse,
  ChangelogEntry,
  Comment,
  PostDetail,
  RoadmapResponse,
} from './types.ts'

export type ApiConfig = {
  apiBase: string
  projectKey: string
  jwt?: string
  appVersion?: string
}

export type Api = ReturnType<typeof createApi>

export function createApi(cfg: ApiConfig) {
  const base = cfg.apiBase.replace(/\/+$/, '')
  let jwt = cfg.jwt

  function headers(json = false): Record<string, string> {
    const h: Record<string, string> = { 'x-chorala-key': cfg.projectKey }
    if (json) h['content-type'] = 'application/json'
    if (jwt) h['x-chorala-user'] = jwt
    return h
  }

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, { credentials: 'include', ...init })
    if (!res.ok) {
      let message = `Request failed (${res.status})`
      try {
        const err = (await res.json()) as { error?: { message?: string } }
        if (err.error?.message) message = err.error.message
      } catch {
        /* ignore */
      }
      throw new Error(message)
    }
    return res.status === 204 ? (null as T) : ((await res.json()) as T)
  }

  const qs = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
    const s = sp.toString()
    return s ? `?${s}` : ''
  }

  return {
    /** Rotate the current identity header without replacing a mounted widget. */
    setJwt: (nextJwt?: string) => {
      jwt = nextJwt
    },
    listBoards: (locale?: string, boardSlug?: string, sort?: string) =>
      req<BoardsResponse>(`/public/boards${qs({ locale, boardSlug, sort })}`, {
        headers: headers(),
      }),
    getPost: (id: string, locale?: string) =>
      req<PostDetail>(`/public/posts/${id}${qs({ locale })}`, { headers: headers() }),
    createPost: (body: {
      boardSlug: string
      title: string
      body: string
      locale?: string
      attachmentIds?: string[]
    }) =>
      req<PostDetail>('/public/posts', {
        method: 'POST',
        headers: headers(true),
        // Auto-attach submission context + the host-declared app version on every post.
        body: JSON.stringify({ ...body, appVersion: cfg.appVersion, metadata: collectContext() }),
      }),
    uploadScreenshot: (dataUrl: string) =>
      req<AttachmentRef>('/public/attachments', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ dataUrl, kind: 'screenshot' }),
      }),
    vote: (id: string, on: boolean) =>
      req<{ voted: boolean; voteCount: number }>(`/public/posts/${id}/vote`, {
        method: on ? 'POST' : 'DELETE',
        headers: headers(),
      }),
    comment: (id: string, body: string) =>
      req<Comment>(`/public/posts/${id}/comments`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ body }),
      }),
    roadmap: (locale?: string) =>
      req<RoadmapResponse>(`/public/roadmap${qs({ locale })}`, { headers: headers() }),
    changelog: () => req<ChangelogEntry[]>('/public/changelog', { headers: headers() }),
  }
}
