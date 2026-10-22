import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const load = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('site-wide noindex and branded UI', () => {
  it('declares noindex in HTML metadata and static asset headers', () => {
    const html = load('../index.html')
    const headers = load('../public/_headers')
    const worker = load('../src/worker/index.ts')

    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />')
    expect(headers).toContain('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex')
    expect(worker).toContain("'X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex'")
    expect(worker).toContain("'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex'")
  })

  it('does not block compliant crawlers from observing the noindex directive', () => {
    const robots = load('../public/robots.txt')
    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    expect(robots).not.toMatch(/^Disallow:\s*\/\s*$/m)
  })

  it('uses the new locally hosted brand and responsive rounded visual system', () => {
    const css = load('../src/client/styles.css')
    const brand = load('../src/client/Brand.tsx')
    const svg = load('../public/totpnest-logo.svg')
    expect(css).toContain(':root[data-theme="light"]')
    expect(css).toContain('color-scheme: light')
    expect(css).toContain('--brand-cyan:')
    expect(css).toContain('border-radius: 21px')
    expect(css).toContain('.dashboard')
    expect(css).toContain('.public-container')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(brand).toContain('src="/totpnest-logo.svg"')
    expect(svg).toContain('<linearGradient')
    expect(svg).toContain('TOTPNest shield and nest symbol')
    expect(svg).toContain('id="codeBars"')
    expect((svg.match(/<rect x="(?:587|654|721|788)"/g) || [])).toHaveLength(4)
    const wordmark = load('../public/totpnest-wordmark.svg')
    expect(wordmark).toContain('id="wordBlue"')
    expect(wordmark).toContain('fill-rule="evenodd"')
    expect(wordmark).not.toContain('<text')
    const readme = load('../README.md')
    expect(readme).toContain('src="public/totpnest-wordmark.svg"')
  })


  it('keeps the official emblem in every documentation preview', () => {
    const previews = [
      'dashboard-preview.svg', 'admin-login-preview.svg',
      'add-code-preview.svg', 'public-share-preview.svg'
    ]
    for (const filename of previews) {
      const graphic = load('../docs/images/' + filename)
      expect(graphic).toContain('id="totpnest-brand-symbol"')
      expect(graphic).toContain('href="#totpnest-brand-symbol"')
      expect(graphic).toContain('id="codeBars"')
      expect(graphic).not.toContain('stroke="#A8F5FF"')
    }
  })

  it('does not expose links to administration from public screens', () => {
    const app = load('../src/client/App.tsx')
    const routes = load('../src/client/routes.ts')
    expect(app).toContain("case 'home': page = <ShareIdHome />; break")
    expect(app).toContain("if (route.kind === 'admin') return <AdminApp theme={theme} onThemeToggle={onThemeToggle} />")
    expect(app).not.toMatch(/href=["']\/admin(?:\/|["'])/)
    expect(routes).toContain("pathname === '/admin'")
  })
})

