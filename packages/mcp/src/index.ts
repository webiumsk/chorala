#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClient } from './client.ts'
import { createHttpListener, readHttpConfig } from './http.ts'
import { createServer } from './server.ts'

const apiUrl = process.env.CHORALA_API_URL ?? 'http://localhost:8787'
const apiKey = process.env.CHORALA_MCP_API_KEY ?? process.env.CHORALA_API_KEY
if (!apiKey) {
  console.error('Set CHORALA_MCP_API_KEY to a Chorala admin API key (hk_...).')
  process.exit(1)
}

const client = createClient({ apiUrl, apiKey })

if (process.env.CHORALA_MCP_TRANSPORT === 'http') {
  const config = readHttpConfig(process.env)
  const http = createHttpListener(() => createServer(client), config)
  http.listen(config.port, config.host, () => {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host
    console.error(`chorala-mcp listening on http://${host}:${config.port}/mcp (authenticated HTTP)`)
  })
} else if (!process.env.CHORALA_MCP_TRANSPORT || process.env.CHORALA_MCP_TRANSPORT === 'stdio') {
  // stdio transport (for local Claude Desktop / Claude Code / Cursor).
  const server = createServer(client)
  await server.connect(new StdioServerTransport())
  console.error('chorala-mcp ready on stdio')
} else {
  throw new Error('CHORALA_MCP_TRANSPORT must be stdio or http.')
}
