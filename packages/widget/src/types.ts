export type View = 'board' | 'roadmap' | 'changelog'
export type Mode = 'floating' | 'inline' | 'manual'

export type WidgetSettings = {
  theme?: 'light' | 'dark'
  position?: 'bottom-right' | 'bottom-left'
  primaryColor?: string
  mode?: Mode
}

export type InitOptions = {
  projectKey: string
  apiUrl?: string
  locale?: string
  /** Host app version — promoted to a first-class, filterable field on every submission. */
  appVersion?: string
  user?: { jwt?: string }
  view?: View
  settings?: WidgetSettings
}

export type AttachmentRef = {
  id: string
  kind: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
}

export type Board = {
  id: string
  slug: string
  name: string
  description: string | null
  kind: string
}

export type Post = {
  id: string
  boardId: string
  title: string
  body: string
  statusId: string | null
  voteCount: number
  commentCount: number
  isPinned: boolean
  displayLocale?: string
  hasVoted?: boolean
}

export type Status = { id: string; name: string; color: string; kind: string }

export type Comment = {
  id: string
  body: string
  authorEndUserId: string | null
  authorMemberId: string | null
  createdAt: string
}

export type PostTranslation = { locale: string; title: string; body: string }

export type BoardsResponse = { boards: Board[]; posts: Post[] }
export type PostDetail = { post: Post; comments: Comment[]; translations: PostTranslation[] }
export type RoadmapResponse = { columns: { status: Status; posts: Post[] }[] }
export type ChangelogEntry = {
  id: string
  title: string
  body: string
  publishedAt: string | null
  displayDate?: string | null
  labels: string[]
}
