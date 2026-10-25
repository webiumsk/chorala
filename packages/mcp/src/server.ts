import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ChoralaClient } from './client.ts'
import { MCP_LIMITS } from './http.ts'

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

/** Build the Chorala MCP server with all SPEC §10 tools, backed by the HTTP client. */
export function createServer(client: ChoralaClient): McpServer {
  const server = new McpServer(
    { name: 'chorala', version: '0.1.0' },
    { maxToolInputElements: MCP_LIMITS.toolInputElements },
  )
  const pid = () => client.getProjectId()

  server.registerTool(
    'list_boards',
    { description: 'List the feedback boards in this project.', inputSchema: {} },
    async () => json(await client.req(`/projects/${await pid()}/boards`)),
  )

  server.registerTool(
    'list_posts',
    {
      description: 'List posts/ideas, optionally filtered by board, status, search, and sort.',
      inputSchema: {
        boardId: z.string().optional(),
        statusId: z.string().optional(),
        search: z.string().optional(),
        sort: z.enum(['top', 'new', 'trending', 'oldest']).optional(),
      },
    },
    async (args) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(args)) if (v) qs.set(k, String(v))
      return json(await client.req(`/projects/${await pid()}/posts?${qs}`))
    },
  )

  server.registerTool(
    'get_post',
    {
      description: 'Get a single post with its comments.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const project = await pid()
      const [post, comments] = await Promise.all([
        client.req(`/projects/${project}/posts/${id}`),
        client.req(`/projects/${project}/posts/${id}/comments`),
      ])
      return json({ post, comments })
    },
  )

  server.registerTool(
    'search_feedback',
    {
      description: 'Semantic search across feedback (falls back to text search if AI is off).',
      inputSchema: { query: z.string() },
    },
    async ({ query }) =>
      json(
        await client.req(`/projects/${await pid()}/posts/search?q=${encodeURIComponent(query)}`),
      ),
  )

  server.registerTool(
    'top_requests',
    {
      description: 'The most-requested ideas, ranked by (weighted) votes.',
      inputSchema: { board: z.string().optional() },
    },
    async ({ board }) => {
      const qs = new URLSearchParams({ sort: 'top' })
      if (board) qs.set('boardId', board)
      return json(await client.req(`/projects/${await pid()}/posts?${qs}`))
    },
  )

  server.registerTool(
    'cluster_themes',
    {
      description: 'AI-generated themes/clusters across the feedback.',
      inputSchema: {},
    },
    async () => {
      const analytics = await client.req<{ clusterThemes: unknown }>(
        `/projects/${await pid()}/analytics`,
      )
      return json(analytics.clusterThemes)
    },
  )

  server.registerTool(
    'summarize_post',
    {
      description: 'Summarize a post and its discussion thread.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      json(await client.req(`/projects/${await pid()}/posts/${id}/summarize`, { method: 'POST' })),
  )

  server.registerTool(
    'update_post_status',
    {
      description: 'Change a post’s status by status name (requires a write-scoped key).',
      inputSchema: { id: z.string(), status: z.string() },
    },
    async ({ id, status }) => {
      const project = await pid()
      const statuses = await client.req<{ id: string; name: string }[]>(
        `/projects/${project}/statuses`,
      )
      const match = statuses.find((s) => s.name.toLowerCase() === status.toLowerCase())
      if (!match)
        throw new Error(
          `No status named "${status}". Available: ${statuses.map((s) => s.name).join(', ')}`,
        )
      return json(
        await client.req(`/projects/${project}/posts/${id}/status`, {
          method: 'POST',
          body: JSON.stringify({ statusId: match.id }),
        }),
      )
    },
  )

  server.registerTool(
    'draft_changelog_from_posts',
    {
      description: 'Draft a markdown changelog entry from a set of shipped post ids.',
      inputSchema: { ids: z.array(z.string().min(1).max(256)).min(1).max(MCP_LIMITS.draftPostIds) },
    },
    async ({ ids }) =>
      json(
        await client.req(`/projects/${await pid()}/changelog/draft`, {
          method: 'POST',
          body: JSON.stringify({ postIds: ids }),
        }),
      ),
  )

  return server
}
