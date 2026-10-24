import assert from 'node:assert/strict'
import { test } from 'node:test'
import { envSchema } from '../src/env.ts'

const fixture = {
  DATABASE_URL: 'postgres://test:test@127.0.0.1:9/chorala_test',
  CHORALA_AUTH_SECRET: 'synthetic_configuration_test_secret_32_chars',
}

test('public URL ports do not select the internal API listening port', () => {
  const parsed = envSchema.parse({ ...fixture, CHORALA_API_URL: 'https://feedback.example:9443' })
  assert.equal(parsed.CHORALA_API_PORT, 8787)
  assert.equal(envSchema.parse({ ...fixture, CHORALA_API_PORT: 8799 }).CHORALA_API_PORT, 8799)
})

test('requires an absolute upload path and rejects values above the upload parser ceiling', () => {
  assert.equal(envSchema.safeParse({ ...fixture, CHORALA_UPLOAD_DIR: './uploads' }).success, false)
  assert.equal(
    envSchema.safeParse({ ...fixture, CHORALA_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024 }).success,
    true,
  )
  assert.equal(
    envSchema.safeParse({ ...fixture, CHORALA_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024 + 1 }).success,
    false,
  )
})

test('validates URL-safe compose passwords without requiring them for external databases', () => {
  assert.equal(envSchema.parse(fixture).CHORALA_DB_PASSWORD, undefined)
  assert.equal(
    envSchema.parse({ ...fixture, CHORALA_DB_PASSWORD: '' }).CHORALA_DB_PASSWORD,
    undefined,
  )
  assert.equal(envSchema.safeParse({ ...fixture, CHORALA_DB_PASSWORD: 'short' }).success, false)
  assert.equal(
    envSchema.safeParse({
      ...fixture,
      CHORALA_DB_PASSWORD: 'synthetic_database_password_1234567890',
    }).success,
    true,
  )
})

test('rejects malformed explicit admin hosts before an application starts', () => {
  assert.equal(
    envSchema.safeParse({ ...fixture, CHORALA_ADMIN_HOSTS: 'https://admin.example' }).success,
    false,
  )
})

test('signup uses explicit string booleans and bootstrap credentials are optional until requested', () => {
  assert.equal(envSchema.parse(fixture).CHORALA_ALLOW_SIGNUP, false)
  assert.equal(
    envSchema.parse({ ...fixture, CHORALA_ALLOW_SIGNUP: 'false' }).CHORALA_ALLOW_SIGNUP,
    false,
  )
  assert.equal(
    envSchema.parse({ ...fixture, CHORALA_ALLOW_SIGNUP: 'true' }).CHORALA_ALLOW_SIGNUP,
    true,
  )
  assert.equal(envSchema.safeParse({ ...fixture, CHORALA_ALLOW_SIGNUP: 'yes' }).success, false)
  assert.equal(
    envSchema.parse({ ...fixture, CHORALA_BOOTSTRAP_EMAIL: '', CHORALA_BOOTSTRAP_PASSWORD: '' })
      .CHORALA_BOOTSTRAP_EMAIL,
    undefined,
  )
  assert.equal(
    envSchema.safeParse({ ...fixture, CHORALA_BOOTSTRAP_PASSWORD: 'short' }).success,
    false,
  )
})
