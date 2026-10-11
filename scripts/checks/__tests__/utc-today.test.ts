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

  it('finds no UTC "today" in the repository outside the allowlist', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'src')
    const outside = findUtcTodaySites(root).filter((f) => !UTC_TODAY_ALLOWED.has(f.file))
    expect(outside).toEqual([])
  })

  it('keeps the allowlist free of files that no longer need it', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'src')
    const flagged = new Set(findUtcTodaySites(root).map((f) => f.file))
    expect([...UTC_TODAY_ALLOWED].filter((f) => !flagged.has(f))).toEqual([])
  })
})
