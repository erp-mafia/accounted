/**
 * Proof that the literal-legal-form ratchet counts the shapes its header
 * lists and leaves the legitimate ones alone. Offending fixtures live only in
 * these strings and in an OS temp directory the end-to-end case creates and
 * deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEGAL_FORM_CODES,
  findLiteralLegalForms,
  findLiteralLegalFormsInSource as scan,
} from '../literal-legal-form.mjs'
import { ENTITY_TYPES } from '@/lib/company/entity-type'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const lines = (source: string) => scan(source).map((f: { line: number }) => f.line)

describe('literal-legal-form: shapes counted', () => {
  it('stays in sync with ENTITY_TYPES', () => {
    expect([...LEGAL_FORM_CODES]).toEqual([...ENTITY_TYPES])
  })

  it('counts a comparison on either side, once per line', () => {
    expect(lines(`if (entityType === 'aktiebolag') {`)).toEqual([1])
    expect(lines(`const isEf = 'enskild_firma' === settings.entity_type`)).toEqual([1])
    expect(lines(`x !== 'ideell_forening' ? a : b`)).toEqual([1])
    expect(lines(`if (a === 'aktiebolag' || a === 'enskild_firma') {`)).toEqual([1])
  })

  it('counts silent defaults, switch arms, zod defaults, default parameters and single-string tags', () => {
    expect(lines(`const form = settings?.entity_type ?? 'enskild_firma'`)).toEqual([1])
    expect(lines(`const form = row.entity_type || 'aktiebolag'`)).toEqual([1])
    expect(lines(`  case 'aktiebolag':`)).toEqual([1])
    expect(lines(`entity_type: z.enum(ENTITY_TYPES).default('aktiebolag'),`)).toEqual([1])
    expect(lines(`function f(entityType: EntityType = 'enskild_firma') {}`)).toEqual([1])
    expect(lines(`  entity_applicability: 'aktiebolag',`)).toEqual([1])
    expect(lines(`  entityOnly: 'enskild_firma',`)).toEqual([1])
  })

  it('reports the line numbers of a multi-line source', () => {
    const source = [
      `const profile = legalFormProfile(entityType)`,
      `if (entityType === 'aktiebolag') return 1`,
      `const x = 2`,
      `const y = z ?? 'enskild_firma'`,
    ].join('\n')
    expect(lines(source)).toEqual([2, 4])
  })
})

describe('literal-legal-form: shapes left alone', () => {
  it('ignores the profile reads that replace the literals', () => {
    expect(lines(`if (filesIncomeReturn(entityType) === 'INK2') {`)).toEqual([])
    expect(lines(`if (hasOwners(entityType)) {`)).toEqual([])
    expect(lines(`const { closing } = resultClosingAccounts(entityType)`)).toEqual([])
  })

  it('ignores array tags, enum lists, registry returns and object keys', () => {
    expect(lines(`  entity_applicability: ['aktiebolag', 'ekonomisk_forening'],`)).toEqual([])
    expect(lines(`  entityOnly: ['aktiebolag'],`)).toEqual([])
    expect(lines(`entity_type: z.enum(['enskild_firma', 'aktiebolag', 'ideell_forening']),`)).toEqual([])
    expect(lines(`  return 'ideell_forening'`)).toEqual([])
    expect(lines(`  ideell_forening: { closing: '2069' },`)).toEqual([])
    expect(lines(`byEntityType(form, { enskild_firma: 1, aktiebolag: 2, ideell_forening: 3 })`)).toEqual([])
  })

  it('does not match lookalike strings', () => {
    expect(lines(`if (form === 'enskild firma') {`)).toEqual([])
    expect(lines(`if (kind === 'aktiebolagslagen') {`)).toEqual([])
    expect(lines(`if (regelverk === 'K1') {`)).toEqual([])
  })
})

describe('literal-legal-form: end to end over a tree', () => {
  it('scans the source dirs, skips tests and the form registry, and sorts by file and line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'literal-legal-form-'))
    tempDirs.push(root)
    const write = (rel: string, body: string) => {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    write('lib/reports/x.ts', `const a = 1\nif (form === 'aktiebolag') {}\n`)
    write('components/y.tsx', `const isEf = form === 'enskild_firma'\nconst z = q ?? 'aktiebolag'\n`)
    write('lib/company/forms/se-aktiebolag.ts', `code: 'aktiebolag' === x\n`)
    write('lib/company/entity-type.ts', `if (x === 'aktiebolag') {}\n`)
    write('lib/reports/__tests__/x.test.ts', `expect(form === 'aktiebolag')\n`)
    write('lib/reports/y.test.ts', `expect(form === 'aktiebolag')\n`)
    write('scripts/z.ts', `if (form === 'aktiebolag') {}\n`)
    write('lib/reports/notes.md', `form === 'aktiebolag'\n`)

    expect(findLiteralLegalForms(root)).toEqual([
      { file: 'components/y.tsx', line: 1, text: `const isEf = form === 'enskild_firma'` },
      { file: 'components/y.tsx', line: 2, text: `const z = q ?? 'aktiebolag'` },
      { file: 'lib/reports/x.ts', line: 2, text: `if (form === 'aktiebolag') {}` },
    ])
  })
})
