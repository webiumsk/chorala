import { strict as assert } from 'node:assert'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ChoralaClient } from '../src/client.ts'
import { createHttpListener, MCP_LIMITS, readHttpConfig } from '../src/http.ts'
import { createServer } from '../src/server.ts'

const TOKEN = 'synthetic_mcp_http_token_for_disposable_tests_1234567890'
const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
}

async function withHttp(
  run: (url: URL, calls: string[], sdkServers: () => number, http: Server) => Promise<void>,
) {
  const calls: string[] = []
  let servers = 0
  const client: ChoralaClient = {
    getProjectId: async () => 'proj_synthetic',
    req: async <T>(path: string) => {
      calls.push(path)
      return [{ id: 'board_synthetic', name: 'Synthetic board' }] as T
    },
  }
  const config = readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: TOKEN })
  const http = createHttpListener(() => {
    servers++
    return createServer(client)
  }, config)
  http.listen(0, config.host)
  await once(http, 'listening')
  const port = (http.address() as AddressInfo).port
  try {
    await run(new URL(`http://127.0.0.1:${port}/mcp`), calls, () => servers, http)
  } finally {
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('HTTP requires a separate strong token and defaults to loopback', () => {
  for (const token of [undefined, '', 'x'.repeat(31), `${'x'.repeat(32)} token`, 'x'.repeat(257)]) {
    assert.throws(() => readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: token }), /CHORALA_MCP_HTTP_TOKEN/)
  }
  const config = readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: TOKEN })
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 8788)
  assert.throws(
    () => readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: TOKEN, CHORALA_MCP_HOST: '0.0.0.0' }),
    /ALLOW_REMOTE/,
  )
  assert.equal(
    readHttpConfig({
      CHORALA_MCP_HTTP_TOKEN: TOKEN,
      CHORALA_MCP_HOST: '0.0.0.0',
      CHORALA_MCP_ALLOW_REMOTE: 'true',
    }).host,
    '0.0.0.0',
  )
  assert.throws(
    () =>
      readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: TOKEN, CHORALA_MCP_HOST: 'https://untrusted.test' }),
    /explicit IP address/,
  )
  for (const port of ['0', '-1', '8788bad', '65536', '1.5']) {
    assert.throws(
      () => readHttpConfig({ CHORALA_MCP_HTTP_TOKEN: TOKEN, CHORALA_MCP_PORT: port }),
      /PORT/,
    )
  }
})

test('missing and incorrect bearer tokens are rejected before SDK creation or body parsing', async () => {
  await withHttp(async (url, calls, servers) => {
    for (const authorization of [undefined, `Bearer ${TOKEN}wrong`, 'Basic synthetic']) {
      const reqHeaders: Record<string, string> = { 'content-type': 'application/json' }
      if (authorization) reqHeaders.authorization = authorization
      const res = await fetch(url, { method: 'POST', headers: reqHeaders, body: '{not-json' })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="chorala-mcp"')
      assert(!JSON.stringify(await res.json()).includes(TOKEN))
    }
    assert.equal(servers(), 0)
    assert.equal(calls.length, 0)
  })
})

test('real SDK clients can initialize and execute multiple authenticated stateless requests', async () => {
  await withHttp(async (url, calls, servers, http) => {
    const client = new Client({ name: 'synthetic-http-test', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: headers.authorization } },
        }),
      )
      const result = await client.listTools()
      assert.equal(result.tools.length, 9)
      const first = await client.callTool({ name: 'list_boards', arguments: {} })
      const second = await client.callTool({ name: 'list_boards', arguments: {} })
      assert.notEqual(first.isError, true)
      assert.notEqual(second.isError, true)
      assert.deepEqual(calls, [
        '/projects/proj_synthetic/boards',
        '/projects/proj_synthetic/boards',
      ])
      assert(servers() >= 4, 'stateless requests must not reuse one SDK server/transport')
      assert.equal(http.requestTimeout, MCP_LIMITS.requestTimeoutMs)
      assert.equal(http.headersTimeout, MCP_LIMITS.headerTimeoutMs)
    } finally {
      await client.close()
    }
  })
})

test('tool element budgets reject wide argument objects before validation or API calls', async () => {
  await withHttp(async (url, calls) => {
    const client = new Client({ name: 'synthetic-budget-test', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: headers.authorization } },
        }),
      )
      const argumentsObject = Object.fromEntries(
        Array.from({ length: MCP_LIMITS.toolInputElements + 1 }, (_, i) => [`unused_${i}`, i]),
      )
      const result = await client.callTool({ name: 'list_boards', arguments: argumentsObject })
      assert.equal(result.isError, true)
      assert.equal(calls.length, 0)
      const ids = Array.from({ length: MCP_LIMITS.draftPostIds }, (_, i) => `post_synthetic_${i}`)
      const valid = await client.callTool({
        name: 'draft_changelog_from_posts',
        arguments: { ids },
      })
      assert.notEqual(valid.isError, true)
      assert.deepEqual(calls, ['/projects/proj_synthetic/changelog/draft'])
    } finally {
      await client.close()
    }
  })
})

test('oversized declared and chunked bodies fail within the reduced transport budget', async () => {
  await withHttp(async (url, calls) => {
    const large = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { padding: 'x'.repeat(MCP_LIMITS.requestBodyBytes) },
    })
    const declared = await fetch(url, { method: 'POST', headers, body: large })
    assert.equal(declared.status, 413)
    await declared.arrayBuffer()

    const chunk = new Uint8Array(4096).fill(32)
    let remaining = Math.ceil((MCP_LIMITS.requestBodyBytes + 1) / chunk.byteLength)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' }
    const chunked = await fetch(url, init)
    assert.equal(chunked.status, 413)
    await chunked.arrayBuffer()
    assert.equal(calls.length, 0)
  })
})

test('authenticated browser-origin and unrelated endpoint requests cannot reach tools', async () => {
  await withHttp(async (url, calls, servers) => {
    const browser = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'https://untrusted.example.test' },
      body: '{}',
    })
    assert.equal(browser.status, 403)
    const wrongPath = new URL('/other', url)
    assert.equal((await fetch(wrongPath, { method: 'POST', headers, body: '{}' })).status, 404)
    assert.equal(servers(), 0)
    assert.equal(calls.length, 0)
  })
})
