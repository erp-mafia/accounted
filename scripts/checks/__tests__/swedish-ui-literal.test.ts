/**
 * Proof that the swedish-ui-literal ratchet counts Swedish text written into
 * UI files and leaves code, English and the stays-Swedish surfaces alone.
 * Fixtures live in these strings and in an OS temp directory the end-to-end
 * case creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SWEDISH_BY_DESIGN,
  findSwedishUiLiterals,
  findSwedishUiLiteralsInSource as scan,
  looksSwedish,
} from '../swedish-ui-literal.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const matches = (source: string, fileName = 'x.tsx') =>
  scan(source, fileName).map((f: { line: number; match: string }) => f.match)

describe('looksSwedish', () => {
  it('reads å, ä, ö and the Swedish function words as Swedish', () => {
    expect(looksSwedish('Ladda upp SIE-fil')).toBe(false)
    expect(looksSwedish('Välj konto...')).toBe(true)
    expect(looksSwedish('Visa alla')).toBe(true)
    expect(looksSwedish('{count} ej mappade')).toBe(true)
    expect(looksSwedish('Visar 1-50 av 60')).toBe(true)
  })

  it('leaves English, code tokens and identifiers alone', () => {
    expect(looksSwedish('Show all')).toBe(false)
    expect(looksSwedish('Showing 1-50 of 60')).toBe(false)
    expect(looksSwedish('av.')).toBe(false)
    expect(looksSwedish('mitt_konto')).toBe(false)
    expect(looksSwedish('att_gora_title')).toBe(false)
    expect(looksSwedish('/import?mode=sie')).toBe(false)
    expect(looksSwedish('h-4 w-4')).toBe(false)
    expect(looksSwedish('')).toBe(false)
  })
})

describe('swedish-ui-literal: shapes counted', () => {
  it('counts JSX text, attributes, expressions, label maps and template literals', () => {
    expect(matches(`export const A = () => <p>Lämna inte sidan</p>`)).toEqual(['Lämna inte sidan'])
    expect(matches(`export const A = () => <input placeholder="Sök konto..." />`)).toEqual(['Sök konto...'])
    expect(matches(`export const A = () => <p>{'Ej mappade'}</p>`)).toEqual(['Ej mappade'])
    expect(matches(`const LABELS = { upload: 'Ladda upp', preview: 'Förhandsgranskning' }`)).toEqual([
      'Förhandsgranskning',
    ])
    expect(matches('toast({ title: `${n} konton skapade` })')).toEqual(['konton skapade'])
    expect(matches(`throw new Error('Kunde inte hämta kontoplanen.')`)).toEqual(['Kunde inte hämta kontoplanen.'])
  })

  it('reads a .ts file as TypeScript', () => {
    expect(matches(`const GROUPS = { a: { label: 'TILLGÅNGAR' } }`, 'engine.ts')).toEqual(['TILLGÅNGAR'])
  })

  it('reports the line of each site', () => {
    const source = [`const a = t('x')`, `const b = 'Stäng'`, `const c = 'Close'`, `const d = <b>Nästa</b>`].join('\n')
    expect(scan(source).map((f: { line: number }) => f.line)).toEqual([2, 4])
  })
})

describe('swedish-ui-literal: shapes left alone', () => {
  it('ignores message keys, English text and code strings', () => {
    expect(matches(`export const A = () => <p className="h-4 w-4">{t('sie_upload.title')}</p>`)).toEqual([])
    expect(matches(`export const A = () => <p>Upload SIE file</p>`)).toEqual([])
  })

  it('ignores imports, string literal types, quoted keys, regexes and console arguments', () => {
    expect(matches(`import x from './åäö'`)).toEqual([])
    expect(matches(`type Bucket = 'tillgångar' | 'skulder'`)).toEqual([])
    expect(matches(`const m = { 'Övrigt': 1 }`)).toEqual([])
    expect(matches(`const re = /^Övrig/`)).toEqual([])
    expect(matches(`console.warn('Kunde inte ladda', err)`)).toEqual([])
  })
})

describe('swedish-ui-literal: repository scan', () => {
  function fixture(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swedish-ui-literal-'))
    tempDirs.push(root)
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    return root
  }

  it('scans UI files only, outside app/api, tests and the stays-Swedish surfaces', () => {
    const swedish = `export const A = () => <p>Välj fil</p>\n`
    const [byDesign] = [...SWEDISH_BY_DESIGN.keys()]
    const root = fixture({
      'components/A.tsx': swedish,
      'components/engine.ts': `export const L = 'INTÄKTER'\n`,
      'app/(dashboard)/x/page.tsx': swedish,
      'extensions/general/e/components/B.tsx': swedish,
      'app/api/x/route.ts': `export const m = 'Kunde inte spara'\n`,
      'app/(dashboard)/x/helpers.ts': `export const m = 'Kunde inte spara'\n`,
      'lib/errors.ts': `export const m = 'Kunde inte spara'\n`,
      'components/__tests__/A.test.tsx': swedish,
      [byDesign]: swedish,
    })
    expect(findSwedishUiLiterals(root).map((f: { file: string; line: number }) => `${f.file}:${f.line}`)).toEqual([
      'app/(dashboard)/x/page.tsx:1',
      'components/A.tsx:1',
      'components/engine.ts:1',
      'extensions/general/e/components/B.tsx:1',
    ])
  })
})
