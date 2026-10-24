/** Normalize a single HTTP Host header; never accept forwarded lists or URL credentials. */
export function normalizeHostHeader(value: string | null): string | null {
  if (!value || /[\s,/@\\?#]/.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    if (!parsed.hostname || parsed.pathname !== '/') return null
    return parsed.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

/** Use the proxy-preserved Host header; forwarded host values never select the admin app. */
export function requestHostname(headers: { get(name: string): string | null }): string | null {
  return normalizeHostHeader(headers.get('host'))
}

/** Admin hosts are an explicit deployment setting; project domains never gain admin routing. */
export function resolveAdminHosts(publicUrl: string, additionalHosts = ''): ReadonlySet<string> {
  const url = new URL(publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('CHORALA_PUBLIC_URL must be an HTTP(S) URL without credentials')
  }
  const primary = normalizeHostHeader(url.host)
  if (!primary) throw new Error('CHORALA_PUBLIC_URL must contain a valid host')
  const hosts = new Set([primary, 'localhost', '127.0.0.1', '[::1]'])
  for (const configured of additionalHosts
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)) {
    const hostname = normalizeHostHeader(configured)
    if (!hostname) throw new Error('CHORALA_ADMIN_HOSTS must contain comma-separated host names')
    hosts.add(hostname)
  }
  return hosts
}

/** Edge-safe configuration access; importing this module never loads dotenv or Node filesystem APIs. */
export function configuredAdminHosts(): ReadonlySet<string> {
  return resolveAdminHosts(
    process.env.CHORALA_PUBLIC_URL ?? 'http://localhost:3015',
    process.env.CHORALA_ADMIN_HOSTS ?? '',
  )
}

/** Admin aliases redirect to the canonical origin instead of widening session trust. */
export function adminAliasRedirect(
  host: string,
  pathname: string,
  search: string,
  publicUrl: string,
  additionalHosts = '',
): string | null {
  const target = new URL(publicUrl)
  if (
    !resolveAdminHosts(publicUrl, additionalHosts).has(host) ||
    host === normalizeHostHeader(target.host) ||
    ['localhost', '127.0.0.1', '[::1]'].includes(host)
  )
    return null
  target.pathname = pathname
  target.search = search
  target.hash = ''
  return target.toString()
}
