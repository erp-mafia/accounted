/**
 * Proof that the raw-reference-fetch ratchet catches the thing and leaves the
 * legitimate shapes alone. Offending fixtures live only in these strings and
 * in an OS temp directory the end-to-end case creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findRawReferenceFetches,
  findRawReferenceFetchesInSource as scan,
  isClientSource,
} from '../raw-reference-fetch.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const kinds = (source: string) => scan(source).map((f: { kind: string }) => f.kind)

describe('raw-reference-fetch: GET-shaped API calls', () => {
  it('flags a bare GET of each reference path, with or without a query string', () => {
    expect(kinds(`const res = await fetch('/api/settings')`)).toEqual(['api'])
    expect(kinds('fetch(`/api/bookkeeping/fiscal-periods`)')).toEqual(['api'])
    expect(kinds(`fetch('/api/bookkeeping/accounts?active=false')`)).toEqual(['api'])
    expect(kinds(`fetch('/api/settings/booking-templates', { signal })`)).toEqual(['api'])
    expect(kinds(`fetch('/api/cash-accounts?enabled_only=true', { headers: { a: '1' } })`)).toEqual(['api'])
    expect(kinds(`fetch(\n  '/api/customers',\n  { signal: controller.signal },\n)`)).toEqual(['api'])
  })

  it('ignores writes: they go through the API and then invalidate the cache', () => {
    expect(kinds(`fetch('/api/settings', { method: 'PUT', body })`)).toEqual([])
    expect(kinds(`fetch('/api/customers', { method: 'POST', headers: { 'content-type': 'x' }, body })`)).toEqual([])
    expect(kinds("fetch(`/api/settings/booking-templates/${id}/touch`, { method: 'POST' })")).toEqual([])
    expect(kinds(`fetch('/api/articles/' + id, { method: 'DELETE' })`)).toEqual([])
  })

  it('does not confuse sub-resources or lookalike paths with the reference lists', () => {
    expect(kinds("fetch(`/api/settings/booking-templates/${id}`)")).toEqual([])
    expect(kinds(`fetch('/api/settings/banking')`)).toEqual([])
    expect(kinds(`fetch('/api/customers/abc')`)).toEqual([])
    expect(kinds(`fetch('/api/bookkeeping/accounts/bas-catalog')`)).toEqual([])
  })
})

describe('raw-reference-fetch: regex safety', () => {
  it('scans a pathological near-miss in linear time (no catastrophic backtracking)', () => {
    // A fetch call that never closes, padded with the whitespace/comma mix
    // the old `\s*,?\s*\)` tail was ambiguous on.
    const source = `fetch('/api/settings'${' ,'.repeat(5000)}${' '.repeat(5000)}X`
    const start = performance.now()
    expect(scan(source)).toEqual([])
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('raw-reference-fetch: use-client detection is linear too', () => {
  it('handles a long run of unclosed block comments without backtracking', () => {
    const source = `${'/* '.repeat(3000)}'use client'\n`
    const start = performance.now()
    expect(isClientSource(source)).toBe(false)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('still sees the directive behind closed comments', () => {
    expect(isClientSource(`/* a */ /* b */\n// c\n'use client'\n`)).toBe(true)
  })
})

describe('raw-reference-fetch: browser-side table reads', () => {
  const clientRead = `'use client'\nimport x from 'y'\nconst { data } = await supabase.from('fiscal_periods').select('*').eq('company_id', id)`

  it('flags a select on a reference table only in a use-client file', () => {
    expect(kinds(clientRead)).toEqual(['table'])
    expect(kinds(clientRead.replace(`'use client'\n`, ''))).toEqual([])
  })

  it('recognises the directive behind leading comments and double quotes', () => {
    expect(isClientSource(`// header\n/* block */\n"use client"\n`)).toBe(true)
    expect(isClientSource(`import a from 'b'\n'use client'`)).toBe(false)
  })

  it('leaves inserts and updates alone', () => {
    expect(kinds(`'use client'\nawait supabase.from('fiscal_periods').insert(row)`)).toEqual([])
    expect(kinds(`'use client'\nawait supabase.from('company_settings').update(patch).eq('company_id', id)`)).toEqual([])
  })
})

describe('raw-reference-fetch: file scan', () => {
  it('reports offending files relative to the root and skips sanctioned, api and test files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-ref-'))
    tempDirs.push(root)
    const write = (rel: string, content: string) => {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    write('components/Bad.tsx', `'use client'\nfetch('/api/settings')`)
    write('components/Fine.tsx', `'use client'\nfetch('/api/settings', { method: 'PUT' })`)
    write('components/__tests__/Bad.test.tsx', `fetch('/api/settings')`)
    write('components/Bad.test.ts', `fetch('/api/settings')`)
    write('lib/reference-data/fetchers.ts', `fetch('/api/settings')`)
    write('app/api/x/route.ts', `fetch('/api/settings')`)
    write('app/(dashboard)/reports/page.tsx', `'use client'\nconst r = await fetch('/api/bookkeeping/fiscal-periods')`)
    write('lib/server-thing.ts', `await supabase.from('company_settings').select('*')`)

    expect(findRawReferenceFetches(root)).toEqual([
      'app/(dashboard)/reports/page.tsx',
      'components/Bad.tsx',
    ])
  })
})
