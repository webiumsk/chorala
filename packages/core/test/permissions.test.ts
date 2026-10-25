import { describe, expect, test } from 'vitest'
import { type AuthContext, assertPermission } from '../src/context.ts'

describe('documented staff roles and API-key scopes', () => {
  const session = (role: AuthContext['role']): AuthContext => ({
    kind: 'session',
    orgId: 'org_test',
    role,
  })
  test('members can read and moderators can moderate without general write authority', () => {
    expect(() => assertPermission(session('member'), 'read')).not.toThrow()
    expect(() => assertPermission(session('member'), 'write')).toThrow('Missing write permission')
    expect(() => assertPermission(session('moderator'), 'moderate')).not.toThrow()
    expect(() => assertPermission(session('moderator'), 'write')).toThrow(
      'Missing write permission',
    )
    expect(() => assertPermission(session('member'), 'moderate')).toThrow(
      'Missing moderate permission',
    )
    expect(() => assertPermission(session('owner'), 'write')).not.toThrow()
    expect(() => assertPermission(session('admin'), 'write')).not.toThrow()
  })
  test('a read-only or malformed key cannot gain write permission', () => {
    const key: AuthContext = {
      kind: 'apikey',
      orgId: 'org_test',
      projectId: 'proj_test',
      scopes: ['read'],
    }
    expect(() => assertPermission(key, 'read')).not.toThrow()
    expect(() => assertPermission(key, 'write')).toThrow('Missing write permission')
    expect(() => assertPermission({ ...key, scopes: [] }, 'read')).toThrow(
      'Missing read permission',
    )
    expect(() => assertPermission({ ...key, scopes: ['admin'] }, 'write')).toThrow(
      'Missing write permission',
    )
    expect(() => assertPermission({ ...key, scopes: ['write'] }, 'write')).not.toThrow()
  })
})
