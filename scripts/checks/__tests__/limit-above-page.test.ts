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
    expect(scan(`const a = 1\nconst b = 2\nq.limit(3000)`)).toEqual([{ line: 3, limit: 3000, arg: '3000' }])
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
