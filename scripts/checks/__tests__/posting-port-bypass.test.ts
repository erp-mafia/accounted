/**
 * Proof that the posting-port-bypass guard (step 3 of the posting port) finds
 * every shape of reaching the engine's posting functions outside the port,
 * leaves the port, the engine's own files, tests, type-only imports and the
 * engine's helpers alone, keeps the SIE writers on their permanent allowlist,
 * and ratchets as (file, name) edges that may only go away. Offending fixtures
 * live only in these strings and in an OS temp directory the tree cases
 * create and delete.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import {
  POSTING_SURFACE,
  ENGINE_HELPERS,
  POSTING_CALLERS,
  PERMANENT_ALLOWLIST,
  findPostingSurfaceUsesInSource,
  findPostingPortBypasses,
  frozenBypassBaseline,
  countEdges,
  isTestFile,
} from '../posting-port-bypass.mjs'
import { compareFileEdges } from '../jurisdiction-welds.mjs'

const REPO = path.resolve(__dirname, '..', '..', '..')
const SURFACE = POSTING_SURFACE as Record<string, string[]>
const HELPERS = ENGINE_HELPERS as Record<string, Record<string, string>>
const ALLOWLIST = PERMANENT_ALLOWLIST as Record<string, { names: string[]; reason: string }>

const uses = (source: string, relPath = 'lib/invoices/door.ts'): string[] =>
  findPostingSurfaceUsesInSource(source, relPath)

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posting-port-bypass-'))
  tempDirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  return root
}

describe('a direct call of the posting surface is found', () => {
  it('counts a named import of a guarded engine function', () => {
    expect(uses(`import { createJournalEntry } from '@/lib/bookkeeping/engine'\n`)).toEqual(['createJournalEntry'])
  })

  it('counts the imported name behind an alias', () => {
    expect(uses(`import { reverseEntry as storno } from '@/lib/bookkeeping/engine'\nstorno()\n`)).toEqual([
      'reverseEntry',
    ])
  })

  it('counts every guarded name of the storno service and the set posting', () => {
    expect(
      uses(
        `import { correctEntry, recordateEntry } from '@/lib/core/bookkeeping/storno-service'\n` +
          `import { createJournalEntries } from '@/lib/bookkeeping/journal-entry-batch'\n`,
      ),
    ).toEqual(['correctEntry', 'createJournalEntries', 'recordateEntry'])
  })

  it('counts the SQL commit wrappers', () => {
    expect(
      uses(`import { commitBulkBooking, commitMatchBatchAllocation, replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'\n`),
    ).toEqual(['commitBulkBooking', 'commitMatchBatchAllocation', 'replaceOpeningBalanceEntry'])
  })

  it('resolves relative paths, with or without an extension, from inside and outside src', () => {
    expect(uses(`import { commitEntry } from './engine'\n`, 'lib/bookkeeping/new-door.ts')).toEqual(['commitEntry'])
    expect(uses(`import { commitEntry } from '../bookkeeping/engine.ts'\n`, 'lib/invoices/door.ts')).toEqual([
      'commitEntry',
    ])
    expect(uses(`import { correctEntry } from './storno-service'\n`, 'lib/core/bookkeeping/x.ts')).toEqual([
      'correctEntry',
    ])
    expect(uses(`import { reverseEntry } from '../src/lib/bookkeeping/engine'\n`, 'scripts/repair.ts')).toEqual([
      'reverseEntry',
    ])
  })

  it('counts the members a namespace import reaches, and the whole surface when it escapes', () => {
    expect(
      uses(`import * as engine from '@/lib/bookkeeping/engine'\nengine.findFiscalPeriod()\nengine.commitEntry()\n`),
    ).toEqual(['commitEntry'])
    expect(uses(`import * as engine from '@/lib/bookkeeping/engine'\nengine['reverseEntry']()\n`)).toEqual([
      'reverseEntry',
    ])
    expect(uses(`import * as engine from '@/lib/bookkeeping/engine'\nconst { createDraftEntry } = engine\n`)).toEqual([
      'createDraftEntry',
    ])
    expect(uses(`import * as engine from '@/lib/bookkeeping/engine'\nrun(engine)\n`)).toEqual(['*'])
    expect(uses(`import engine = require('@/lib/bookkeeping/engine')\nengine.commitEntry()\n`)).toEqual([
      'commitEntry',
    ])
  })

  it('counts a dynamic import() and require()', () => {
    expect(uses(`const { createJournalEntry } = await import('@/lib/bookkeeping/engine')\n`)).toEqual([
      'createJournalEntry',
    ])
    expect(uses(`const { reverseEntry: undo } = await import('../../src/lib/bookkeeping/engine')\n`, 'scripts/x/y.ts')).toEqual([
      'reverseEntry',
    ])
    expect(uses(`const engine = await import('@/lib/bookkeeping/engine')\nawait engine.reverseEntry()\n`)).toEqual([
      'reverseEntry',
    ])
    expect(uses(`export async function f() {\n  await (await import('@/lib/bookkeeping/engine')).commitEntry()\n}\n`)).toEqual([
      'commitEntry',
    ])
    expect(uses(`import('@/lib/bookkeeping/engine').then((m) => m.commitEntry())\n`)).toEqual(['*'])
    expect(uses(`const pending = import('@/lib/bookkeeping/engine')\npending.then((m) => m.commitEntry())\n`)).toEqual(['*'])
    expect(uses(`const { commitEntry } = require('@/lib/bookkeeping/engine')\n`, 'scripts/x.js')).toEqual([
      'commitEntry',
    ])
  })

  it('counts a re-export, which would launder the surface through another module', () => {
    expect(uses(`export { reverseEntry as undo } from '@/lib/bookkeeping/engine'\n`)).toEqual(['reverseEntry'])
    expect(uses(`export * from '@/lib/core/bookkeeping/storno-service'\n`)).toEqual(['*'])
  })
})

describe('what is not a call of the posting surface', () => {
  it('leaves type-only imports and type positions alone', () => {
    expect(uses(`import type { CreateEntryOptions } from '@/lib/bookkeeping/engine'\n`)).toEqual([])
    expect(uses(`import type { correctEntry } from '@/lib/core/bookkeeping/storno-service'\n`)).toEqual([])
    expect(uses(`import { type reverseEntry } from '@/lib/bookkeeping/engine'\n`)).toEqual([])
    expect(uses(`export type { CorrectionBusinessEvents } from '@/lib/core/bookkeeping/storno-service'\n`)).toEqual([])
    expect(uses(`type E = typeof import('@/lib/bookkeeping/engine')\n`)).toEqual([])
    expect(
      uses(`import * as engine from '@/lib/bookkeeping/engine'\ntype R = ReturnType<typeof engine.reverseEntry>\n`),
    ).toEqual([])
  })

  it("leaves the engine's helpers alone", () => {
    expect(
      uses(
        `import { findFiscalPeriod, validateBalance, peekNextVoucherNumber, assertLinesWellFormed } from '@/lib/bookkeeping/engine'\n` +
          `import { updateDraftEntry, cancelDraftEntry, cancelOrphanedEntry } from '@/lib/bookkeeping/engine'\n`,
      ),
    ).toEqual([])
  })

  it('leaves the posting port itself and modules of a similar name alone', () => {
    expect(uses(`import { postingPort } from '@/lib/posting/port'\n`)).toEqual([])
    expect(uses(`import { commitEntry } from '@/lib/bookkeeping/engine-v2'\n`)).toEqual([])
    expect(uses(`import { commitEntry } from 'engine'\n`)).toEqual([])
    expect(uses(`// createJournalEntry from '@/lib/bookkeeping/engine'\nconst s = 'reverseEntry'\n`)).toEqual([])
  })

  it('treats __tests__, *.test.ts(x) and the root tests/ tree as tests', () => {
    expect(isTestFile('lib/invoices/__tests__/a.ts')).toBe(true)
    expect(isTestFile('lib/invoices/a.test.ts')).toBe(true)
    expect(isTestFile('components/a.test.tsx')).toBe(true)
    expect(isTestFile('tests/pg/posting-parity.pg.test.ts')).toBe(true)
    expect(isTestFile('tests/helpers.ts')).toBe(true)
    expect(isTestFile('lib/invoices/testing.ts')).toBe(false)
  })
})

describe('end to end over a tree', () => {
  const ENGINE = `import { createJournalEntry } from '@/lib/bookkeeping/engine'\n`

  it('fails a new door, and passes the port, the engine, tests and scripts reaching only helpers', () => {
    const root = tree({
      'src/lib/invoices/new-door.ts': ENGINE,
      'src/app/api/x/route.ts': `import { reverseEntry } from '@/lib/bookkeeping/engine'\n`,
      'src/extensions/general/e/lib/book.ts': `import { correctEntry } from '@/lib/core/bookkeeping/storno-service'\n`,
      'src/lib/posting/ledger-adapter.ts': ENGINE,
      'src/lib/posting/sub/helper.ts': ENGINE,
      'src/lib/bookkeeping/engine.ts': `export function createJournalEntry() {}\n`,
      'src/lib/core/bookkeeping/storno-service.ts': `import { commitStornoOrCorrectionDraft } from '@/lib/bookkeeping/engine'\n`,
      'src/lib/bookkeeping/journal-entry-batch.ts': `import { commitEntry, createDraftEntry } from './engine'\n`,
      'src/lib/invoices/__tests__/door.test.ts': ENGINE,
      'src/lib/invoices/door.test.ts': ENGINE,
      'src/lib/invoices/helpers-only.ts': `import { findFiscalPeriod } from '@/lib/bookkeeping/engine'\n`,
      'scripts/repair.ts': `import { reverseEntry } from '../src/lib/bookkeeping/engine'\n`,
      'scripts/read-only.ts': `import { validateBalance } from '../src/lib/bookkeeping/engine'\n`,
      'tests/pg/flow.ts': ENGINE,
    })
    expect(findPostingPortBypasses(root)).toEqual({
      bypasses: {
        'app/api/x/route.ts': ['reverseEntry'],
        'extensions/general/e/lib/book.ts': ['correctEntry'],
        'lib/invoices/new-door.ts': ['createJournalEntry'],
        'scripts/repair.ts': ['reverseEntry'],
      },
      allowlisted: {},
    })
  })

  it("keeps the SIE worker's two chunk writers on the permanent allowlist, and nothing else of it", () => {
    const root = tree({
      'src/lib/import/sie-job-worker.ts':
        `import { commitSIEImportChunk, reverseSIEImportChunk, createJournalEntry } from '@/lib/bookkeeping/engine'\n`,
      'src/lib/import/other-worker.ts': `import { commitSIEImportChunk } from '@/lib/bookkeeping/engine'\n`,
    })
    expect(findPostingPortBypasses(root)).toEqual({
      bypasses: {
        'lib/import/other-worker.ts': ['commitSIEImportChunk'],
        'lib/import/sie-job-worker.ts': ['createJournalEntry'],
      },
      allowlisted: { 'lib/import/sie-job-worker.ts': ['commitSIEImportChunk', 'reverseSIEImportChunk'] },
    })
  })
})

describe('the ratchet', () => {
  const baseline = {
    'lib/transactions/bulk-book.ts': ['commitBulkBooking'],
    'lib/pending-operations/commit.ts': ['createJournalEntry', 'reverseEntry'],
  }

  it('fails a new edge, also in a baselined file, even when another edge went away in the same change', () => {
    const { added, removed } = compareFileEdges(baseline, {
      'lib/transactions/bulk-book.ts': ['commitBulkBooking', 'commitEntry'],
      'lib/invoices/new-door.ts': ['reverseEntry'],
    })
    expect(added).toEqual([
      { file: 'lib/transactions/bulk-book.ts', module: 'commitEntry' },
      { file: 'lib/invoices/new-door.ts', module: 'reverseEntry' },
    ])
    expect(removed).toEqual([
      { file: 'lib/pending-operations/commit.ts', module: 'createJournalEntry' },
      { file: 'lib/pending-operations/commit.ts', module: 'reverseEntry' },
    ])
  })

  it('passes a shrinking set: removed edges only', () => {
    const { added, removed } = compareFileEdges(baseline, { 'lib/transactions/bulk-book.ts': ['commitBulkBooking'] })
    expect(added).toEqual([])
    expect(removed).toHaveLength(2)
  })

  it('--update drops the edges that went away and never grandfathers a new one', () => {
    const next = frozenBypassBaseline(baseline, {
      'lib/transactions/bulk-book.ts': ['commitBulkBooking', 'commitEntry'],
      'lib/invoices/new-door.ts': ['reverseEntry'],
    })
    expect(next).toEqual({ 'lib/transactions/bulk-book.ts': ['commitBulkBooking'] })
    expect(countEdges(next)).toBe(1)
  })

  it('--update introduces the baseline from what is found when there was none', () => {
    expect(frozenBypassBaseline(undefined, baseline)).toEqual(baseline)
  })
})

/** The value exports of a module's source (functions, classes, variables, export lists), never types. */
function valueExports(source: string): string[] {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const stmt of sf.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && exported(stmt) && stmt.name) {
      names.push(stmt.name.text)
    } else if (ts.isVariableStatement(stmt) && exported(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text)
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (!el.isTypeOnly) names.push(el.name.text)
    }
  }
  return names.sort()
}

describe('the surface is classified and points at code that exists', () => {
  it.each(Object.keys(SURFACE))('every value export of %s is guarded or a named helper, never both', (mod) => {
    const source = fs.readFileSync(path.join(REPO, 'src', `${mod}.ts`), 'utf8')
    const exportsNow = valueExports(source)
    const guarded = SURFACE[mod]
    const helpers = Object.keys(HELPERS[mod] ?? {})
    // A new export must be classified when it is written: guarded if it
    // creates, numbers, reverses or corrects a verifikat, else a helper with
    // its reason.
    expect(exportsNow.filter((n) => !guarded.includes(n) && !helpers.includes(n))).toEqual([])
    // A renamed or removed function must leave the lists, or it guards nothing.
    expect([...guarded, ...helpers].filter((n) => !exportsNow.includes(n))).toEqual([])
    expect(guarded.filter((n) => helpers.includes(n))).toEqual([])
  })

  it('every helper states why it stays open', () => {
    for (const reasons of Object.values(HELPERS)) {
      for (const reason of Object.values(reasons)) expect(reason.length).toBeGreaterThan(10)
    }
  })

  it.each(POSTING_CALLERS as string[])('posting caller %s exists', (entry) => {
    const full = path.join(REPO, 'src', entry)
    expect(fs.existsSync(full)).toBe(true)
    if (entry.endsWith('/')) expect(fs.statSync(full).isDirectory()).toBe(true)
  })

  it('every permanent allowlist entry names an existing file, guarded names and a reason', () => {
    for (const [file, { names, reason }] of Object.entries(ALLOWLIST)) {
      expect(fs.existsSync(path.join(REPO, 'src', file))).toBe(true)
      const guarded = Object.values(SURFACE).flat()
      expect(names.filter((n) => !guarded.includes(n))).toEqual([])
      expect(reason.length).toBeGreaterThan(40)
    }
  })

  // Scans every file under src/ and scripts/: well past vitest's 5 s default
  // on a loaded CI runner.
  it('the real tree still has the SIE writers the permanent allowlist names', { timeout: 60_000 }, () => {
    const { allowlisted } = findPostingPortBypasses(REPO)
    expect(allowlisted).toEqual(
      Object.fromEntries(Object.entries(ALLOWLIST).map(([file, { names }]) => [file, [...names].sort()])),
    )
  })
})
