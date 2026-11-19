/**
 * Proof that the client-server-only guard follows static imports from a
 * 'use client' module to the bookkeeping engine or the BAS reference data,
 * and only those. Fixtures live in an OS temp directory the test creates and
 * deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findClientServerOnlyReachers } from '../client-server-only.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-server-only-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

const ENGINE = `import { BAS_REFERENCE } from './bas-data'\nexport async function createJournalEntry() { return BAS_REFERENCE }\n`
const BAS_DATA = `export const BAS_REFERENCE = [{ account_number: '1930' }]\n`
const BAS_REFERENCE = `import { BAS_REFERENCE } from './bas-data'\nexport const getBASReference = (n: string) => BAS_REFERENCE.find((a) => a.account_number === n)\n`

describe('client-server-only guard', () => {
  it('flags a client chain to the engine, with the BAS data it pulls', () => {
    const root = fixture({
      'lib/bookkeeping/engine.ts': ENGINE,
      'lib/bookkeeping/bas-data/index.ts': BAS_DATA,
      'lib/invoices/credit.ts': `import { createJournalEntry } from '@/lib/bookkeeping/engine'\nexport const needsEntry = () => true\nexport const book = createJournalEntry\n`,
      'components/SendDialog.tsx': `'use client'\nimport { needsEntry } from '@/lib/invoices/credit'\nexport default function SendDialog() { return needsEntry() ? null : null }\n`,
    })
    const findings = findClientServerOnlyReachers(root)
    expect(findings.map((f) => [f.file, f.target])).toEqual([
      ['components/SendDialog.tsx', 'lib/bookkeeping/bas-data/'],
      ['components/SendDialog.tsx', 'lib/bookkeeping/engine.ts'],
    ])
    expect(findings[1].chain).toEqual(['components/SendDialog.tsx', 'lib/invoices/credit.ts', 'lib/bookkeeping/engine.ts'])
  })

  it('flags bas-reference.ts reached through a non-client module', () => {
    const root = fixture({
      'lib/bookkeeping/bas-reference.ts': BAS_REFERENCE,
      'lib/bookkeeping/bas-data/index.ts': BAS_DATA,
      'lib/cash-accounts/payee.ts': `export { getBASReference } from '../bookkeeping/bas-reference'\nexport const isBank = () => true\n`,
      'app/settings/page.tsx': `'use client'\nimport { isBank } from '@/lib/cash-accounts/payee'\nexport default function Page() { return isBank() ? null : null }\n`,
    })
    const targets = findClientServerOnlyReachers(root).map((f) => f.target)
    expect(targets).toEqual(['lib/bookkeeping/bas-data/', 'lib/bookkeeping/bas-reference.ts'])
  })

  it('ignores server modules, type-only imports and dynamic imports', () => {
    const root = fixture({
      'lib/bookkeeping/engine.ts': `export type EntryInput = { date: string }\n${ENGINE}`,
      'lib/bookkeeping/bas-data/index.ts': BAS_DATA,
      'app/api/route.ts': `import { createJournalEntry } from '@/lib/bookkeeping/engine'\nexport const POST = createJournalEntry\n`,
      'components/TypeOnly.tsx': `'use client'\nimport type { EntryInput } from '@/lib/bookkeeping/engine'\nexport const input: EntryInput = { date: '' }\n`,
      'components/Lazy.tsx': `'use client'\nexport async function load() { const m = await import('@/lib/bookkeeping/engine'); return m.createJournalEntry }\n`,
    })
    expect(findClientServerOnlyReachers(root)).toEqual([])
  })

  it('resolves the pure sibling pattern as clean', () => {
    const root = fixture({
      'lib/bookkeeping/engine.ts': ENGINE,
      'lib/bookkeeping/bas-data/index.ts': BAS_DATA,
      'lib/bookkeeping/booking-mode.ts': `export const creditNoteNeedsJournalEntry = () => true\n`,
      'lib/invoices/credit.ts': `import { createJournalEntry } from '@/lib/bookkeeping/engine'\nexport { creditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'\nexport const book = createJournalEntry\n`,
      'components/SendDialog.tsx': `'use client'\nimport { creditNoteNeedsJournalEntry } from '@/lib/bookkeeping/booking-mode'\nexport default function SendDialog() { return creditNoteNeedsJournalEntry() ? null : null }\n`,
    })
    expect(findClientServerOnlyReachers(root)).toEqual([])
  })
})
