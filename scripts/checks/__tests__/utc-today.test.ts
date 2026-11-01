/**
 * Proof that the utc-today guard finds the hand-written "today" shapes and
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

  // The forms the guard did not see until November 2026: every one of them was
  // alive in the code, and each answers last year on New Year's night.
  it('flags the calendar getters read off the clock', () => {
    const root = fixture({
      'lib/getters.ts': [
        `const year = new Date().getFullYear()`,
        `const month = new Date().getUTCMonth()`,
        `export function late(now: Date, opts: { now: Date }) {`,
        `  return now.getMonth() + opts.now.getFullYear()`,
        `}`,
        `export function start(today: Date) {`,
        `  return today.getUTCDate()`,
        `}`,
        `const clock = new Date()`,
        `const day = clock.getDate()`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root).map((f) => f.line)).toEqual([1, 2, 4, 7, 10])
  })

  it('flags the fallback forms', () => {
    const root = fixture({
      'lib/fallback.ts': [
        `export function key(date?: Date) {`,
        `  const target = date || new Date()`,
        `  return target.toISOString().split('T')[0]`,
        `}`,
        `export const a = (date?: Date) => (date ?? new Date()).toISOString().split('T')[0]`,
        `export const b = (date?: Date) => (date || new Date()).getFullYear()`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root).map((f) => f.line)).toEqual([3, 5, 6])
  })

  it('flags an exported wrapper where it lands, and a wrapper built from getters', () => {
    const root = fixture({
      'lib/stamp.ts': [
        `export function isoDate(d: Date): string {`,
        `  return d.toISOString().slice(0, 10)`,
        `}`,
        `export function localDate(date: Date): string {`,
        `  const y = date.getFullYear()`,
        `  const m = String(date.getMonth() + 1).padStart(2, '0')`,
        `  const d = String(date.getDate()).padStart(2, '0')`,
        `  return \`\${y}-\${m}-\${d}\``,
        `}`,
      ].join('\n'),
      'lib/one.ts': [
        `import { isoDate, localDate as day } from './stamp'`,
        `export const a = isoDate(new Date())`,
        `export const b = day(new Date())`,
        `export const c = isoDate(row.created)`,
      ].join('\n'),
      'app/api/two/route.ts': [
        `import { isoDate } from '@/lib/stamp'`,
        `export const a = (now: Date) => isoDate(now)`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root)).toEqual([
      { file: 'app/api/two/route.ts', line: 2 },
      { file: 'lib/one.ts', line: 2 },
      { file: 'lib/one.ts', line: 3 },
    ])
  })

  it('leaves a same-named function from another module alone', () => {
    const root = fixture({
      'lib/stamp.ts': `export function isoDate(d: Date): string {\n  return d.toISOString().slice(0, 10)\n}\n`,
      'lib/other.ts': `export function isoDate(y: number): string {\n  return String(y)\n}\n`,
      'lib/one.ts': `import { isoDate } from './other'\nexport const a = isoDate(new Date())\n`,
    })
    expect(findUtcTodaySites(root)).toEqual([])
  })

  it('flags a date printed in the process zone and a second body of the helper', () => {
    const root = fixture({
      'components/Z.tsx': [
        `import { format } from 'date-fns'`,
        `export const a = new Date().toLocaleDateString('sv-SE')`,
        `export const b = format(new Date(), 'yyyy-MM-dd')`,
        `export const c = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())`,
        `export const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })`,
      ].join('\n'),
      'lib/whole.ts': [
        `const STOCKHOLM = new Intl.DateTimeFormat('sv-SE', {`,
        `  timeZone: 'Europe/Stockholm',`,
        `  year: 'numeric',`,
        `  month: '2-digit',`,
        `  day: '2-digit',`,
        `})`,
      ].join('\n'),
    })
    expect(findUtcTodaySites(root)).toEqual([
      { file: 'components/Z.tsx', line: 2 },
      { file: 'components/Z.tsx', line: 3 },
      { file: 'components/Z.tsx', line: 4 },
      { file: 'components/Z.tsx', line: 5 },
      { file: 'lib/whole.ts', line: 1 },
    ])
  })

  it('leaves arithmetic on an instant, stored dates and worded dates alone', () => {
    const root = fixture({
      'lib/ok-getters.ts': [
        `export function cutoff() {`,
        `  const d = new Date()`,
        `  d.setDate(d.getDate() - 7)`,
        `  return d.toISOString()`,
        `}`,
        `export const y = (row: { at: string }) => new Date(row.at).getFullYear()`,
        `export const when = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long' })`,
        `export const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit' }).format(new Date())`,
        `export const weekday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long' }).format(new Date())`,
        `export const stored = (date?: Date) => (date ? date.toISOString().split('T')[0] : null)`,
        `export const stamp = (date?: string) => date || new Date().toISOString()`,
        `export const utcDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC' }).format(stored)`,
        `export function readBack(todayIso: string) {`,
        `  const parsed = new Date(todayIso + 'T00:00:00Z')`,
        `  return parsed.getUTCFullYear()`,
        `}`,
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
