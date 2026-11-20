import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstLoadFiles, measureRoute, overBudget, routeToAppPath } from '../perf/page-js.mjs'

/** A build directory with one page: two shared files, one page chunk, one lazy chunk nothing references. */
function fakeBuild(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'page-js-'))
  mkdirSync(path.join(dir, 'static/chunks'), { recursive: true })
  mkdirSync(path.join(dir, 'server/app/(dashboard)/invoices'), { recursive: true })
  writeFileSync(path.join(dir, 'static/chunks/main.js'), 'a'.repeat(4000))
  writeFileSync(path.join(dir, 'static/chunks/polyfill.js'), 'b'.repeat(1000))
  writeFileSync(path.join(dir, 'static/chunks/page.js'), 'c'.repeat(2000))
  writeFileSync(path.join(dir, 'static/chunks/lazy-dialog.js'), 'd'.repeat(9000))
  writeFileSync(
    path.join(dir, 'build-manifest.json'),
    JSON.stringify({ rootMainFiles: ['static/chunks/main.js'], polyfillFiles: ['static/chunks/polyfill.js'] }),
  )
  writeFileSync(
    path.join(dir, 'app-path-routes-manifest.json'),
    JSON.stringify({ '/(dashboard)/invoices/page': '/invoices' }),
  )
  const manifest = {
    entryJSFiles: { '[project]/src/app/(dashboard)/invoices/page': ['static/chunks/main.js', 'static/chunks/page.js'] },
    clientModules: { m1: { chunks: ['/_next/static/chunks/page.js', '/_next/static/chunks/page.css'] } },
  }
  writeFileSync(
    path.join(dir, 'server/app/(dashboard)/invoices/page_client-reference-manifest.js'),
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {}; globalThis.__RSC_MANIFEST["/(dashboard)/invoices/page"] = ${JSON.stringify(manifest)};`,
  )
  return dir
}

describe('page-js: what a page ships on a hard load', () => {
  it('finds the app path that serves a route', () => {
    expect(routeToAppPath('/invoices', { '/(dashboard)/invoices/page': '/invoices' })).toBe('/(dashboard)/invoices/page')
    expect(routeToAppPath('/nope', { '/(dashboard)/invoices/page': '/invoices' })).toBeNull()
  })

  it('counts each referenced script once and leaves out stylesheets and lazy chunks', () => {
    const files = firstLoadFiles(
      { rootMainFiles: ['static/chunks/main.js'], polyfillFiles: ['static/chunks/polyfill.js'] },
      {
        entryJSFiles: { page: ['static/chunks/main.js', 'static/chunks/page.js'] },
        clientModules: { m1: { chunks: ['/_next/static/chunks/page.js', '/_next/static/chunks/page.css'] } },
      },
    )
    expect(files).toEqual(['static/chunks/main.js', 'static/chunks/page.js', 'static/chunks/polyfill.js'])
  })

  it('measures a route from a build directory', () => {
    const row = measureRoute(fakeBuild(), '/invoices')
    expect(row.files).toBe(3)
    expect(row.rawBytes).toBe(7000)
    expect(row.brotliBytes).toBeGreaterThan(0)
    expect(row.brotliBytes).toBeLessThan(row.rawBytes)
  })

  it('fails a page over its budget and a page without one', () => {
    const rows = [
      { route: '/a', brotliBytes: 101 * 1024 },
      { route: '/b', brotliBytes: 100 * 1024 },
      { route: '/c', brotliBytes: 1 },
    ]
    expect(overBudget(rows, { '/a': { jsBrotliKb: 100 }, '/b': { jsBrotliKb: 100 }, '/c': { jsBrotliKb: null } })).toEqual([
      '/a: 101 kB is over its budget of 100 kB',
      '/c: no jsBrotliKb budget',
    ])
  })
})
