import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const load = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('site-wide noindex and square-corner UI', () => {
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

  it('uses square corners throughout the stylesheet', () => {
    const css = load('../src/client/styles.css')
    expect(css).toContain('*{box-sizing:border-box;border-radius:0}')
    expect(css.match(/border-radius:/g)).toHaveLength(1)
  })

  it('does not expose links to administration from public screens', () => {
    const app = load('../src/client/App.tsx')
    const routes = load('../src/client/routes.ts')
    expect(app).toContain("case 'home': return <ShareIdHome />")
    expect(app).toContain("case 'admin': return <AdminApp />")
    expect(app).not.toMatch(/href=["']\/admin(?:\/|["'])/)
    expect(routes).toContain("pathname === '/admin'")
  })
})

