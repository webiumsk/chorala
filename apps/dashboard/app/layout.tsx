import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { cookies } from 'next/headers'
import type { CSSProperties, ReactNode } from 'react'
import { THEME_IDS } from '@/lib/themes'
import './globals.css'

const sans = localFont({
  src: [{ path: './fonts/HankenGrotesk-Variable.ttf', weight: '400 700', style: 'normal' }],
  variable: '--font-hanken',
  display: 'swap',
})

const display = localFont({
  src: [
    { path: './fonts/Fraunces-Variable.ttf', weight: '400 600', style: 'normal' },
    { path: './fonts/Fraunces-Italic-Variable.ttf', weight: '400 600', style: 'italic' },
  ],
  variable: '--font-fraunces',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
})

export const metadata: Metadata = {
  title: 'Chorala — Admin',
  description: 'Chorala feedback platform dashboard',
  robots: { index: false, follow: false },
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies()
  const cookieTheme = jar.get('chorala-theme')?.value
  // No saved theme → omit data-theme so CSS `prefers-color-scheme` decides (auto dark).
  const valid = !!cookieTheme && (THEME_IDS.includes(cookieTheme) || cookieTheme === 'custom')
  const theme = valid ? cookieTheme : undefined

  // Custom palette: inject the 3 base colours on SSR so the derived tokens resolve with no flash.
  let style: CSSProperties | undefined
  if (cookieTheme === 'custom') {
    try {
      const c = JSON.parse(jar.get('chorala-custom')?.value ?? '{}')
      style = {
        '--c-paper': c.paper,
        '--c-ink': c.ink,
        '--c-accent': c.accent,
      } as CSSProperties
    } catch {
      /* malformed cookie → fall back to custom defaults */
    }
  }

  return (
    <html
      lang="en"
      data-theme={theme}
      style={style}
      className={`${sans.variable} ${display.variable}`}
    >
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  )
}
