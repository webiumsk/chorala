import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adminAliasRedirect,
  normalizeHostHeader,
  requestHostname,
  resolveAdminHosts,
} from '../src/hosts.ts'

test('uses the configured admin domain while keeping unrelated project domains separate', () => {
  const hosts = resolveAdminHosts('https://feedback.owner.example', 'admin.owner.example')
  assert.equal(hosts.has('feedback.owner.example'), true)
  assert.equal(hosts.has('admin.owner.example'), true)
  assert.equal(hosts.has('chorala.com'), false)
  assert.equal(hosts.has('feedback.customer.example'), false)
})

test('normalizes case, development ports, IPv6 and a canonical trailing dot', () => {
  const hosts = resolveAdminHosts('http://LOCALHOST:3015')
  assert.equal(hosts.has(normalizeHostHeader('LOCALHOST:3015') ?? ''), true)
  assert.equal(hosts.has(normalizeHostHeader('[::1]:3015') ?? ''), true)
  assert.equal(normalizeHostHeader('Feedback.Owner.Example.:443'), 'feedback.owner.example')
})

test('rejects lists, credentials, URL paths and malformed host headers', () => {
  for (const host of [
    null,
    '',
    'admin.example,evil.example',
    'evil@admin.example',
    'admin.example/path',
    'admin.example?x=1',
    'admin.example#admin',
    'admin.example\\evil',
    'admin.example:bad',
    ' admin.example',
  ]) {
    assert.equal(normalizeHostHeader(host), null)
  }
})

test('does not promote a project domain based on a spoofed forwarded host', () => {
  const headers = new Headers({
    host: 'customer.example',
    'x-forwarded-host': 'admin.owner.example',
  })
  const hosts = resolveAdminHosts('https://admin.owner.example')
  assert.equal(requestHostname(headers), 'customer.example')
  assert.equal(hosts.has(requestHostname(headers) ?? ''), false)
})

test('invalid explicit admin host configuration fails closed', () => {
  assert.throws(() => resolveAdminHosts('ftp://admin.example'))
  assert.throws(() => resolveAdminHosts('https://user:pass@admin.example'))
  assert.throws(() => resolveAdminHosts('https://admin.example', 'https://other.example'))
})

test('configured aliases preserve the route but send login to the canonical origin', () => {
  assert.equal(
    adminAliasRedirect(
      'alias.example',
      '/login',
      '?next=%2Fadmin',
      'https://feedback.example:9443',
      'alias.example',
    ),
    'https://feedback.example:9443/login?next=%2Fadmin',
  )
  assert.equal(
    adminAliasRedirect(
      'feedback.example',
      '/login',
      '',
      'https://feedback.example',
      'alias.example',
    ),
    null,
  )
  assert.equal(
    adminAliasRedirect(
      'customer.example',
      '/login',
      '',
      'https://feedback.example',
      'alias.example',
    ),
    null,
  )
  assert.equal(
    adminAliasRedirect('127.0.0.1', '/login', '', 'https://feedback.example', 'alias.example'),
    null,
  )
})
