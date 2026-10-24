# MCP transport security

The MIT-licensed MCP package remains separate from the AGPL server. It imports no
server configuration or domain code, and retains its existing license notice.
Its operator API key must be scoped to the intended project; use a read-only key
unless status mutations are needed. The key is never an HTTP authentication token.

## Default local transport

`CHORALA_MCP_TRANSPORT` defaults to `stdio`. Existing local MCP client configuration
continues to work without opening a listening socket or requiring an HTTP token.

## Optional authenticated HTTP

Set `CHORALA_MCP_TRANSPORT=http` and supply an independent random
`CHORALA_MCP_HTTP_TOKEN` through the protected environment. Generate at least 32
random bytes, for example with `openssl rand -hex 32`. Tokens must contain 32-256
bearer-token characters. Do not place tokens in URLs, source, terminal examples
containing real credentials or public configuration.

The listener defaults to `127.0.0.1:8788`. The canonical endpoint is `/mcp`; `/`
remains accepted for earlier clients. Every request requires
`Authorization: Bearer <HTTP token>` before SDK creation or body parsing. Token
digests are compared in constant time. Browser `Origin` headers are rejected; this
credential is intended for trusted MCP clients, not frontend JavaScript.

`CHORALA_MCP_PORT` accepts integers from 1 through 65535. `CHORALA_MCP_HOST` accepts
`localhost` or an IP address. A non-loopback bind additionally requires the explicit
`CHORALA_MCP_ALLOW_REMOTE=true` opt-in. Never expose cleartext authenticated HTTP
to an untrusted network. Put approved remote access behind TLS and network access
controls; leave the backend listener on loopback where a local proxy is used.
HTTP mode fails at startup if token or bind configuration is invalid. Neither
HTTP tokens nor the operator's Chorala API key are printed in logs.

Each authenticated POST gets a fresh stateless SDK server/transport, closed when
the response closes. This preserves repeated requests without sharing MCP session
state between clients. The listener does not enable browser CORS or cookies.

## Resource bounds

- HTTP bodies: 64 KiB, including requests without `Content-Length`.
- Tool arguments: at most 256 array elements/object keys before schema validation.
- Changelog drafting: 1-100 post IDs, each at most 256 characters.
- Headers: at most 8 KiB and 32 fields.
- Header timeout: 10 seconds; incoming request and idle socket timeout: 30 seconds.
- Keep-alive timeout: 5 seconds; at most 32 connections and 100 requests per socket.

SDK 1.32.0 alone does not enable the argument budget: both `maxToolInputElements`
and transport `maxRequestBodySize` are configured explicitly. See the primary
[SDK advisory GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453).
No default size limit is treated as proof of protection.

Runtime regression tests use the real MCP SDK against ephemeral loopback servers
and a synthetic in-memory Chorala client. They verify authentication precedes
parsing, repeated valid requests, argument budgets, declared/chunked body limits
and rejected browser access. They do not contact production or require a real API
key. The separate stdio smoke test remains available against disposable fixtures.
