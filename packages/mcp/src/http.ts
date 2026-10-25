import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { isIP } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/** Deliberately bounded independently of the operator's Chorala API credentials. */
export const MCP_LIMITS = {
  toolInputElements: 256,
  requestBodyBytes: 64 * 1024,
  draftPostIds: 100,
  headerTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
} as const

type Environment = Record<string, string | undefined>
export type HttpConfig = { host: string; port: number; token: string }
const loopback = new Set(['127.0.0.1', '::1', 'localhost'])

function validateToken(token: string | undefined): asserts token is string {
  if (!token || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new Error('CHORALA_MCP_HTTP_TOKEN must contain 32-256 bearer-token characters.')
  }
}

/** HTTP is opt-in and never falls back to anonymous access or a wildcard bind. */
export function readHttpConfig(environment: Environment): HttpConfig {
  const token = environment.CHORALA_MCP_HTTP_TOKEN
  validateToken(token)
  const host = environment.CHORALA_MCP_HOST ?? '127.0.0.1'
  if (host !== 'localhost' && !isIP(host)) {
    throw new Error('CHORALA_MCP_HOST must be localhost or an explicit IP address.')
  }
  if (!loopback.has(host) && environment.CHORALA_MCP_ALLOW_REMOTE !== 'true') {
    throw new Error('A non-loopback MCP bind requires CHORALA_MCP_ALLOW_REMOTE=true.')
  }
  const rawPort = environment.CHORALA_MCP_PORT ?? '8788'
  const port = Number(rawPort)
  if (!/^[1-9]\d{0,4}$/.test(rawPort) || port > 65535) {
    throw new Error('CHORALA_MCP_PORT must be an integer from 1 to 65535.')
  }
  return { host, port, token }
}

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
    ...(status === 401 ? { 'www-authenticate': 'Bearer realm="chorala-mcp"' } : {}),
  })
  res.end(JSON.stringify({ error: message }))
}

/** A fresh stateless SDK server/transport per authenticated request avoids shared sessions. */
export function createHttpListener(makeServer: () => McpServer, config: HttpConfig) {
  validateToken(config.token)
  const expected = createHash('sha256').update(config.token).digest()
  const authorized = (req: IncomingMessage) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')
    const supplied = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest()
    return timingSafeEqual(supplied, expected) && match !== null
  }

  const http = createHttpServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    // Authenticate before creating an SDK server or letting it consume the request body.
    if (!authorized(req)) return reject(res, 401, 'Authentication required')
    // This operator credential is for MCP clients, never browser applications.
    if (req.headers.origin) return reject(res, 403, 'Browser origins are not supported')
    if (req.url !== '/' && req.url !== '/mcp') return reject(res, 404, 'Not found')
    if (req.method !== 'POST') return reject(res, 405, 'Method not allowed')
    const length = req.headers['content-length']
    if (length && (!/^\d+$/.test(length) || Number(length) > MCP_LIMITS.requestBodyBytes)) {
      return reject(res, 413, 'Request body is too large')
    }

    const server = makeServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_LIMITS.requestBodyBytes,
    })
    res.once('close', () => {
      void server.close().catch(() => {})
    })
    void (async () => {
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res)
      } catch {
        // Never log request headers, bearer tokens, API credentials or tool arguments.
        if (!res.headersSent) reject(res, 500, 'MCP request failed')
        else res.destroy()
        await server.close().catch(() => {})
      }
    })()
  })
  http.headersTimeout = MCP_LIMITS.headerTimeoutMs
  http.requestTimeout = MCP_LIMITS.requestTimeoutMs
  http.keepAliveTimeout = 5_000
  http.maxHeadersCount = 32
  http.maxConnections = 32
  http.maxRequestsPerSocket = 100
  http.setTimeout(MCP_LIMITS.idleTimeoutMs, (socket) => socket.destroy())
  return http
}
