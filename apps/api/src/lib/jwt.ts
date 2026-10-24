import { type EndUserJwtPayload, endUserJwtPayload } from '@chorala/types'
import { jwtVerify } from 'jose'

/**
 * Verify a host-signed end-user JWT (HS256 with the project's `end_user_jwt_secret`).
 * jose performs a constant-time HMAC comparison (SPEC §13). Throws on any failure.
 */
export async function verifyEndUserJwt(token: string, secret: string): Promise<EndUserJwtPayload> {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['HS256'],
    requiredClaims: ['iat', 'exp'],
    maxTokenAge: '24h',
    clockTolerance: 5,
  })
  if (
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 86_400
  ) {
    throw new Error('End-user token must have a lifetime of at most 24 hours')
  }
  return endUserJwtPayload.parse(payload)
}
