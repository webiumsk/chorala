# @chorala/mcp — Chorala MCP server (MIT)

Expose your Chorala feedback to AI clients (Claude Desktop, Claude Code, Cursor) as
[Model Context Protocol](https://modelcontextprotocol.io) tools. Triage feedback,
search semantically, and draft changelogs from inside your assistant.

This package is **MIT** and talks to the Chorala HTTP API over the network with an
project-scoped API key (`hk_…`) — it imports none of the server code. Prefer a
read-only key unless status changes are required.

## Tools

| Tool | What it does |
|---|---|
| `list_boards` | List the project's boards |
| `list_posts` | List posts (filter by board/status/search/sort) |
| `get_post` | A post + its comments |
| `search_feedback` | Semantic search (text fallback if AI is off) |
| `top_requests` | Most-requested ideas by (weighted) votes |
| `cluster_themes` | AI-generated themes across feedback |
| `summarize_post` | Summarize a post's thread |
| `update_post_status` | Change a post's status by name (needs a write key) |
| `draft_changelog_from_posts` | Draft a markdown changelog from shipped posts |

## Configuration

Two env vars:

- `CHORALA_MCP_API_KEY` — a Chorala API key (`hk_…`), created in **Project → API keys**.
  It is scoped to a single project.
- `CHORALA_API_URL` — base URL of the Chorala API (default `http://localhost:8787`).

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chorala": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/packages/mcp/src/index.ts"],
      "env": {
        "CHORALA_MCP_API_KEY": "hk_live_xxx",
        "CHORALA_API_URL": "https://feedback.yourcompany.com"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add chorala \
  --env CHORALA_MCP_API_KEY=hk_live_xxx \
  --env CHORALA_API_URL=https://feedback.yourcompany.com \
  -- npx -y tsx /absolute/path/to/packages/mcp/src/index.ts
```

## Transports

- **stdio** (default) — for local Claude Desktop / Claude Code / Cursor.
- **streamable HTTP** — set `CHORALA_MCP_TRANSPORT=http` and a separate random
  `CHORALA_MCP_HTTP_TOKEN` of 32–256 characters. Every request requires that token
  as a bearer credential. The listener defaults to `127.0.0.1:8788`; remote binding
  requires an explicit opt-in and protected TLS/network access. Browser origins
  are rejected. Request and tool-input budgets apply before expensive validation.

See [MCP transport security](../../docs/MCP_SECURITY.md) for exact limits, binding
options and runtime tests. The backend API key is never the HTTP access token.

## Run locally

```bash
CHORALA_MCP_API_KEY=hk_xxx CHORALA_API_URL=http://localhost:8787 pnpm --filter @chorala/mcp start
```
