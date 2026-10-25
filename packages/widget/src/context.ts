// Collect diagnostic context without copying host-page identifiers or credentials.

/** Keep only an HTTP origin: paths, user info, queries and fragments can contain secrets. */
export function contextOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function parseUserAgent(ua: string): { browser?: string; os?: string } {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : undefined
  const ver =
    browser && new RegExp(`${browser === 'Safari' ? 'Version' : browser}/([0-9.]+)`).exec(ua)
  const os = /Windows NT 10/.test(ua)
    ? 'Windows 10/11'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /(iPhone|iPad|iPod)/.test(ua)
            ? 'iOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : undefined
  return { browser: browser && ver ? `${browser} ${ver[1]}` : browser, os }
}

/** A flat, JSON-safe map of where/how this feedback was filed. Undefined keys are dropped. */
export function collectContext(): Record<string, string> {
  const out: Record<string, string | undefined> = {}
  try {
    const ua = navigator.userAgent
    const { browser, os } = parseUserAgent(ua)
    out.url = contextOrigin(location.href)
    out.referrer = contextOrigin(document.referrer)
    out.locale = navigator.language
    out.browser = browser
    out.os = os
    out.userAgent = ua
    out.screen = `${screen.width}×${screen.height}`
    out.viewport = `${window.innerWidth}×${window.innerHeight}`
    if (window.devicePixelRatio && window.devicePixelRatio !== 1) {
      out.dpr = String(window.devicePixelRatio)
    }
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    /* best-effort; a locked-down host may block some globals */
  }
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(out)) if (v) clean[k] = v
  return clean
}
