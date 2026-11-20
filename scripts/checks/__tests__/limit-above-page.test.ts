/**
 * Proof that the limit-above-page guard catches a `.limit()` PostgREST will
 * silently cut at 1000 rows, leaves samples at or below one page alone, and
 * that the repository holds no such call outside the shrinking allowlist.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  findLimitsAbovePage,
  findLimitsAbovePageInSource as scan,
  LIMIT_ABOVE_PAGE_ALLOWED,
} from '../limit-above-page.mjs'

const limits = (source: string) => scan(source).map((f: { limit: number }) => f.limit)

describe('limit-above-page: literals', () => {
  it('flags a literal above one page, with or without separators', () => {
    expect(limits(`supabase.from('x').select('id').limit(5000)`)).toEqual([5000])
    expect(limits(`q.limit(1001)`)).toEqual([1001])
    expect(limits(`q.limit(20_000)`)).toEqual([20000])
    expect(limits(`q\n  .limit( 2000 )`)).toEqual([2000])
  })

  it('leaves a page or less alone: that is a sample, not a silent cut', () => {
    expect(limits(`q.limit(1000)`)).toEqual([])
    expect(limits(`q.limit(200)`)).toEqual([])
    expect(limits(`q.limit(1).maybeSingle()`)).toEqual([])
  })

  it('reports the line of the call', () => {
    expect(scan(`const a = 1\nconst b = 2\nq.limit(3000)`)).toEqual([{ line: 3, limit: 3000, arg: '3000', call: '.limit(3000)' }])
  })
})

describe('limit-above-page: a limit option handed to a reader', () => {
  it('flags a numeric limit option above one page (accounted#16)', () => {
    // The parties register asked getObservedParties for 5000 keys; the RPC
    // behind it returns 1000 at most, and no .limit( was ever written.
    expect(scan(`getObservedParties(supabase, companyId, { fromDate, limit: 5000 }),`)).toEqual([
      { line: 1, limit: 5000, arg: '5000', call: 'limit: 5000' },
    ])
    expect(limits(`supabase.rpc('x', { p_company_id: id, p_limit: 2_000 })`)).toEqual([2000])
    expect(limits(`read(db, {\n  limit: 1001\n})`)).toEqual([1001])
  })

  it('leaves a page or less, other keys and named constants alone', () => {
    expect(limits(`getObservedParties(supabase, companyId, { limit: 1000 })`)).toEqual([])
    expect(limits(`fetchAllRows(q, { maxRows: 5000 })`)).toEqual([])
    expect(limits(`stripe.list({ limit: MAX_TXNS_PER_RUN })`)).toEqual([])
    expect(limits(`const ratelimit = { limit: 100 }`)).toEqual([])
  })

  it('reports call and option findings in source order', () => {
    expect(scan(`read({ limit: 5000 })\nq.limit(2000)`).map((f: { call: string }) => f.call)).toEqual(['limit: 5000', '.limit(2000)'])
  })
})

describe('limit-above-page: named constants', () => {
  it('resolves a constant declared in the same file', () => {
    expect(limits(`const LINE_CAP = 20000\nq.limit(LINE_CAP)`)).toEqual([20000])
    expect(limits(`const DOC_CAP: number = 5_000;\nq.limit(DOC_CAP)`)).toEqual([5000])
  })

  it('leaves a constant of a page or less, an unknown name and an expression alone', () => {
    expect(limits(`const AGREEMENTS = 12\nq.limit(AGREEMENTS)`)).toEqual([])
    expect(limits(`q.limit(limit)`)).toEqual([])
    expect(limits(`q.limit(limit * 4)`)).toEqual([])
  })
})

describe('limit-above-page: the repository', () => {
  const findings = findLimitsAbovePage(path.resolve(__dirname, '..', '..', '..', 'src'))

  it('has no .limit() above one page outside the allowlist', () => {
    const outside = findings.filter((f: { file: string }) => !LIMIT_ABOVE_PAGE_ALLOWED.has(f.file))
    expect(outside).toEqual([])
  })

  it('allowlists only files that still offend, so the list can only shrink', () => {
    const offending = new Set(findings.map((f: { file: string }) => f.file))
    expect([...LIMIT_ABOVE_PAGE_ALLOWED].filter((f) => !offending.has(f))).toEqual([])
  })
})
