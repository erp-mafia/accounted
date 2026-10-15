/**
 * Proof that the utc-today guard finds the inline UTC "today" shapes and
 * nothing else, and that the repository holds none outside the allowlist.
 * Fixtures live in an OS temp directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findUtcTodaySites, UTC_TODAY_ALLOWED } from '../utc-today.mjs'

/** The repository scans walk all of src: seconds locally, longer on the shared CI runner. */
const REPO_SCAN_TIMEOUT_MS = 60_000

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utc-today-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

describe('utc-today guard', () => {
  it('flags the slice, substring, split and toIsoDate shapes with their line', () => {
    const root = fixture({
      'lib/a.ts': `const a = new Date().toISOString().slice(0, 10)\nconst b = new Date().toISOString().substring(0,10)\n`,
      'components/B.tsx': `export const c = () => new Date().toISOString().split('T')[0]\n`,
      'app/api/x/route.ts': `\n\nconst d = toIsoDate(new Date())\n`,
    })
    expect(findUtcTodaySites(root)).toEqual([
      { file: 'app/api/x/route.ts', line: 3 },
      { file: 'components/B.tsx', line: 1 },
      { file: 'lib/a.ts', line: 1 },
      { file: 'lib/a.ts', line: 2 },
    ])
  })

  it('leaves timestamps, other dates, tests and the Stockholm helper alone', () => {
    const root = fixture({
      'lib/ok.ts': [
        `const at = new Date().toISOString()`,
        `const day = toIsoDate(someDate)`,
        `const other = row.created_at.slice(0, 10)`,
        `const today = todayIsoStockholm()`,
      ].join('\n'),
      'lib/__tests__/x.test.ts': `const t = new Date().toISOString().slice(0, 10)\n`,
      'lib/y.test.ts': `const t = new Date().toISOString().slice(0, 10)\n`,
    })
    expect(findUtcTodaySites(root)).toEqual([])
  })

  // accounted#18: the same UTC date read off a clock variable, or off a
  // horizon derived from one, a line after `new Date()`.
  it('flags the date part of a clock variable and of a horizon derived from one', () => {
    const root = fixture({
      'lib/deadlines/status.ts': [
        `export function run(supabase, now: Date = new Date()) {`,
        `  const today = now.toISOString().slice(0, 10)`,
        `  const horizonDate = new Date(now.getTime() + 14 * 86_400_000)`,
        `  const horizon = horizonDate.toISOString().split('T')[0]`,
        `  return { today, horizon }`,
        `}`,
      ].join('\n'),
      'lib/b.ts': [
        `const start = new Date()`,
        `start.setMonth(start.getMonth() - 3)`,
        `const since = start.toISOString().substring(0, 10)`,
        `const later = new Date(Date.now() + 1000)`,
        `const l = later.toISOString().slice(0, 10)`,
      ].join('\n'),
      'lib/c.ts': [
        `export function read(opts: { now?: Date }) {`,
        `  const at = opts.now ?? new Date()`,
        `  const a = at.toISOString().slice(0, 10)`,
        `  return [a, opts.now!.toISOString().slice(0, 10), opts.now?.toISOString().split('T')[0]]`,
        `}`,
      ].join('\n'),
      'components/D.tsx': [
        `function isoDay(date: Date): string {`,
        `  return date.toISOString().slice(0, 10)`,
        `}`,
        `const iso = (d: Date) => d.toISOString().split('T')[0]`,
        `export const max = isoDay(new Date())`,
        `export const t = (now: Date) => iso(now) + toIsoDate(now)`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root)).toEqual([
      { file: 'components/D.tsx', line: 5 },
      { file: 'components/D.tsx', line: 6 },
      { file: 'lib/b.ts', line: 3 },
      { file: 'lib/b.ts', line: 5 },
      { file: 'lib/c.ts', line: 3 },
      { file: 'lib/c.ts', line: 4 },
      { file: 'lib/deadlines/status.ts', line: 2 },
      { file: 'lib/deadlines/status.ts', line: 4 },
    ])
  })

  it('leaves dates built from stored dates and other objects alone', () => {
    const root = fixture({
      'lib/ok-dates.ts': [
        `export function due(invoiceDate: string, terms: number) {`,
        `  const d = new Date(invoiceDate)`,
        `  d.setDate(d.getDate() + terms)`,
        `  return d.toISOString().slice(0, 10)`,
        `}`,
        `function isoDay(date: Date): string {`,
        `  return date.toISOString().slice(0, 10)`,
        `}`,
        `export const first = isoDay(new Date(row.created_at))`,
        `export const own = row.d.toISOString().slice(0, 10)`,
        `export const at = now.toISOString()`,
        `const notAClock = new Date(invoiceDate)`,
        `export const n = notAClock.toISOString().slice(0, 10)`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root)).toEqual([])
  })

  it('finds no UTC "today" in the repository outside the allowlist', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'src')
    const outside = findUtcTodaySites(root).filter((f) => !UTC_TODAY_ALLOWED.has(f.file))
    expect(outside).toEqual([])
  }, REPO_SCAN_TIMEOUT_MS)

  it('keeps the allowlist free of files that no longer need it', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'src')
    const flagged = new Set(findUtcTodaySites(root).map((f) => f.file))
    expect([...UTC_TODAY_ALLOWED].filter((f) => !flagged.has(f))).toEqual([])
  }, REPO_SCAN_TIMEOUT_MS)
})
