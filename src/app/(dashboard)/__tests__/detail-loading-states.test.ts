/**
 * Every [id] detail segment ships a route-level loading.tsx, and its client
 * page no longer collapses into the bare centred spinner while it fetches:
 * the RSC fallback and the client fallback share one silhouette
 * (components/common/DetailPageSkeleton), so opening a row never flashes
 * three unrelated layouts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(__dirname, '..')
const DETAIL_SEGMENTS = [
  'customers/[id]',
  'invoices/[id]',
  'invoices/[id]/edit',
  'invoices/[id]/credit',
  'bookkeeping/[id]',
  'supplier-invoices/[id]',
  'suppliers/[id]',
  'articles/[id]',
  'salary/runs/[id]',
]
const LIST_SEGMENTS = ['customers', 'invoices', 'quotes', 'suppliers', 'articles', 'supplier-invoices']

describe('detail and list segments have a route-level loading state', () => {
  for (const segment of [...DETAIL_SEGMENTS, ...LIST_SEGMENTS]) {
    it(`${segment}/loading.tsx exists`, () => {
      expect(fs.existsSync(path.join(APP, segment, 'loading.tsx'))).toBe(true)
    })
  }
})

describe('detail pages do not gate on the bare centred spinner', () => {
  for (const segment of DETAIL_SEGMENTS) {
    it(`${segment}/page.tsx uses the shared skeleton, not h-64 + SpinnerIcon`, () => {
      const source = fs.readFileSync(path.join(APP, segment, 'page.tsx'), 'utf8')
      expect(source).not.toMatch(/justify-center h-64">\s*<SpinnerIcon/)
    })
  }
})

// The register lists paint the one list silhouette (ListPageSkeleton) for
// their route fallback: eight hand-drawn copies of it had drifted apart.
describe('register lists share the list silhouette', () => {
  for (const segment of ['customers', 'suppliers', 'articles', 'invoices', 'supplier-invoices', 'transactions', 'bookkeeping', 'salary']) {
    it(`${segment}/loading.tsx renders ListPageSkeleton`, () => {
      const src = fs.readFileSync(path.join(APP, segment, 'loading.tsx'), 'utf8')
      expect(src).toContain('<ListPageSkeleton')
    })
  }
})
