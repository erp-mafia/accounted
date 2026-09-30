/**
 * Proof that the jurisdiction-weld ratchets (bas-account-literal, sek-literal,
 * kernel-import) count the shapes their header lists, leave the legitimate
 * ones alone, and compare against a baseline per file. Offending fixtures live
 * only in these strings and in an OS temp directory the end-to-end case
 * creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SE_PACK_TERRITORY,
  CURRENCY_CONVERSION_CODE,
  KERNEL_FILES,
  KERNEL_INNER_MODULES,
  findBasAccountWeldsInSource,
  findSekComparisonsInSource,
  findKernelImportsInSource,
  findJurisdictionWelds,
  isInnerModule,
  isNonAccountReceiver,
  countByFile,
  compareFileCounts,
  compareFileEdges,
} from '../jurisdiction-welds.mjs'

const SRC = path.resolve(__dirname, '..', '..', '..', 'src')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

type BasFinding = { line: number; kind: string; match: string }
const bas = (source: string) => findBasAccountWeldsInSource(source).map((f: BasFinding) => f.kind)
const sek = (source: string) => findSekComparisonsInSource(source).length

describe('bas-account-literal: shapes counted', () => {
  it('counts every quoted four-digit account literal, in any quote style', () => {
    expect(bas(`const bank = '1930'`)).toEqual(['literal'])
    expect(bas(`debit_account: "2650",`)).toEqual(['literal'])
    expect(bas('const x = `3001`')).toEqual(['literal'])
    expect(bas(`const cash = ['1910', '1920', '1930']`)).toEqual(['literal', 'literal', 'literal'])
    expect(bas(`if (account >= '3000' && account <= '3999') {`)).toEqual(['literal', 'literal'])
  })

  it('counts a digit-prefix startsWith on an account, whatever the variable is called', () => {
    expect(bas(`if (account.startsWith('19')) {`)).toEqual(['prefix-startsWith'])
    expect(bas(`lines.filter((a) => a.startsWith('3'))`)).toEqual(['prefix-startsWith'])
    expect(bas(`(targetAccount ?? '').startsWith('264')`)).toEqual(['prefix-startsWith'])
    expect(bas(`r.account_number.startsWith('26') || r.account_number.startsWith('27')`)).toEqual([
      'prefix-startsWith',
      'prefix-startsWith',
    ])
  })

  it('counts slice and charAt prefix comparisons on either side', () => {
    expect(bas(`if (acc.slice(0, 2) === '26') {`)).toEqual(['prefix-slice'])
    expect(bas(`nums.filter((num) => num.charAt(0) !== '1')`)).toEqual(['prefix-slice'])
    expect(bas(`if ('26' === acc.substring(0, 2)) {`)).toEqual(['prefix-slice'])
  })

  it('counts regex prefix tests on account digits', () => {
    expect(bas(`if (/^19\\d{2}$/.test(account)) {`)).toEqual(['prefix-regex'])
    expect(bas(`.refine((a) => /^[4-8]/.test(a))`)).toEqual(['prefix-regex'])
    expect(bas(`if (/^(26|27)\\d\\d$/.test(account)) {`)).toEqual(['prefix-regex'])
    expect(bas(`const RE = /^[123]\\d{3}$/`)).toEqual(['prefix-regex'])
    expect(bas(`z.string().regex(/^19[2-9]\\d$/, 'Bankkonton')`)).toEqual(['prefix-regex'])
  })

  it('judges a receiver by its word segments, so account-named and date-lookalike names count', () => {
    expect(bas(`if (accountCode.startsWith('19')) {}`)).toEqual(['prefix-startsWith'])
    expect(bas(`if (basCode.startsWith('3')) {}`)).toEqual(['prefix-startsWith'])
    expect(bas(`if (updatedAccount.startsWith('26')) {}`)).toEqual(['prefix-startsWith'])
    expect(bas(`if (candidate.startsWith('19')) {}`)).toEqual(['prefix-startsWith'])
    expect(bas(`if (updated.slice(0, 2) === '26') {}`)).toEqual(['prefix-slice'])
  })

  it('counts code that follows a block comment closed on the same line', () => {
    expect(bas(`/* bank */ const bank = '1930'`)).toEqual(['literal'])
    expect(bas(`{/* note */} {acc.startsWith('26') && <Vat />}`)).toEqual(['prefix-startsWith'])
  })

  it('reports the line numbers of a multi-line source', () => {
    const source = [
      `import { RESULT_ACCOUNT } from '@/lib/core/bookkeeping/result-appropriation-service'`,
      `const bank = '1930'`,
      `const x = 2`,
      `if (a.startsWith('19')) {}`,
    ].join('\n')
    expect(findBasAccountWeldsInSource(source).map((f: BasFinding) => f.line)).toEqual([2, 4])
  })
})

describe('bas-account-literal: shapes left alone', () => {
  it('ignores dates, longer numbers, bare numbers and non-account digits', () => {
    expect(bas(`const d = '2026-01-01'`)).toEqual([])
    expect(bas(`const ocr = '19300'`)).toEqual([])
    expect(bas(`const n = 1930`)).toEqual([])
    expect(bas(`const status = '0123'`)).toEqual([])
    expect(bas(`const internal = '9100'`)).toEqual([])
  })

  it('ignores digit prefixes on other number series', () => {
    expect(bas(`if (digits.startsWith('16')) {}`)).toEqual([])
    expect(bas(`if (orgNumber.startsWith('5')) {}`)).toEqual([])
    expect(bas(`errCode.startsWith('42')`)).toEqual([])
    expect(bas(`if (phone.startsWith('46')) {}`)).toEqual([])
    expect(bas(`if (account.startsWith('0')) {}`)).toEqual([])
    expect(bas(`if (sqlState.startsWith('42')) {}`)).toEqual([])
    expect(bas(`if (bankgiroNumber.startsWith('5')) {}`)).toEqual([])
    expect(bas(`if (ORG_NR.startsWith('5')) {}`)).toEqual([])
    expect(bas(`if (fiscalYear.startsWith('2')) {}`)).toEqual([])
  })

  it('isNonAccountReceiver splits camelCase and snake_case names into segments', () => {
    for (const name of ['digits', 'errCode', 'canonical', 'personnummer', 'isoDate', 'plusgiro', 'SQLSTATE'])
      expect(isNonAccountReceiver(name), name).toBe(true)
    for (const name of ['a', 'value', 'candidate', 'updated', 'accountCode', 'account_code', 'basCode', 'kontonr'])
      expect(isNonAccountReceiver(name), name).toBe(false)
  })

  it('ignores regexes for longer numbers, years and non-account classes', () => {
    expect(bas(`const SWISH = /^123\\d{7}$/`)).toEqual([])
    expect(bas(`if (/^(16|18|19|20)\\d{10}$/.test(cleaned)) {}`)).toEqual([])
    expect(bas(`const YEAR_LIKE_RE = /^(?:19|20)\\d{2}$/`)).toEqual([])
    expect(bas(`return /^(19|20)/.test(digits)`)).toEqual([])
    expect(bas(`z.string().regex(/^[0-9a-f]{64}$/)`)).toEqual([])
    expect(bas(`z.string().regex(/^[1-9]\\d*$/)`)).toEqual([])
    expect(bas(`/^([01]\\d|2[0-3]):[0-5]\\d$/.test(value)`)).toEqual([])
    expect(bas(`const ACCOUNT_NUMBER_RE = /^\\d{4}$/`)).toEqual([])
  })

  it('ignores comment lines', () => {
    expect(bas(`// Bank is '1930' and VAT settles on '2650'`)).toEqual([])
    expect(bas(` * starts with /^19\\d{2}$/ and account.startsWith('19')`)).toEqual([])
    expect(bas(`{/* '1930' */}`)).toEqual([])
    expect(bas(`/* '1930' is the bank account`)).toEqual([])
    expect(bas(`  /* bank '1930' */  `)).toEqual([])
  })
})

describe('sek-literal', () => {
  it('counts a comparison against SEK on either side, once per occurrence', () => {
    expect(sek(`if (currency === 'SEK') {`)).toBe(1)
    expect(sek(`const foreign = invoice.currency !== "SEK"`)).toBe(1)
    expect(sek(`if ('SEK' == c || c != 'SEK') {`)).toBe(2)
    expect(sek('const isSek = `SEK` === row.currency')).toBe(1)
  })

  it('leaves other uses of SEK alone', () => {
    expect(sek(`const DEFAULT_CURRENCY = 'SEK'`)).toBe(0)
    expect(sek(`formatCurrency(amount, 'SEK')`)).toBe(0)
    expect(sek(`const list = ['SEK', 'EUR']`)).toBe(0)
    expect(sek(`if (currency === 'SEKX') {}`)).toBe(0)
    expect(sek(`// only when currency === 'SEK'`)).toBe(0)
  })
})

describe('kernel-import', () => {
  it('counts outer business modules through every import form, resolved and sorted', () => {
    const source = [
      `import { a } from '@/lib/invoices/customer-share'`,
      `import type { B } from '@/lib/reports/trial-balance'`,
      `export { c } from '@/lib/salary/account-mapping'`,
      `import { d } from '../../bokslut/rounding'`,
      `const e = await import('@/extensions/general/stripe')`,
      `import '@/lib/import/side-effect'`,
    ].join('\n')
    expect(findKernelImportsInSource(source, 'lib/core/bookkeeping/x.ts')).toEqual([
      'extensions/general/stripe',
      'lib/bokslut/rounding',
      'lib/import/side-effect',
      'lib/invoices/customer-share',
      'lib/reports/trial-balance',
      'lib/salary/account-mapping',
    ])
  })

  it('leaves the kernel, the legal-form seam, shared infrastructure and packages alone', () => {
    const source = [
      `import { x } from './period-service'`,
      `import { createJournalEntry } from '@/lib/bookkeeping/engine'`,
      `import { resultClosingAccounts } from '@/lib/company/entity-type'`,
      `import { eventBus } from '@/lib/events'`,
      `import type { EventPayload } from '@/lib/events/types'`,
      `import { roundOre } from '@/lib/money'`,
      `import type { JournalEntry } from '@/types'`,
      `import type { SupabaseClient } from '@supabase/supabase-js'`,
      `import { createHash } from 'node:crypto'`,
    ].join('\n')
    expect(findKernelImportsInSource(source, 'lib/core/bookkeeping/x.ts')).toEqual([])
  })

  it('counts the features that share a directory with the seam or with infrastructure', () => {
    const source = [
      `import { createCompany } from '@/lib/company/create-company'`,
      `import { parseOnboardingInput } from '../../company/onboarding-input'`,
      `import { fetchRiksbankRate } from '@/lib/currency/riksbanken'`,
      `import { startBankId } from '@/lib/auth/bankid'`,
      `import { importExisting } from '@/lib/dimensions/import-existing'`,
      `import { handler } from '@/lib/events/handlers/document-read-handler'`,
    ].join('\n')
    expect(findKernelImportsInSource(source, 'lib/core/bookkeeping/x.ts')).toEqual([
      'lib/auth/bankid',
      'lib/company/create-company',
      'lib/company/onboarding-input',
      'lib/currency/riksbanken',
      'lib/dimensions/import-existing',
      'lib/events/handlers/document-read-handler',
    ])
  })

  it('leaves the seam and the listed infrastructure modules alone', () => {
    const source = [
      `import { getLegalFormProfile } from '@/lib/company/forms'`,
      `import { AB_PROFILE } from '@/lib/company/forms/se-aktiebolag'`,
      `import { createServiceClientNoCookies } from '@/lib/auth/api-keys'`,
      `import { eventBus } from '@/lib/events/bus'`,
      `import { fetchAllRows } from '@/lib/supabase/fetch-all'`,
      `import { fiscalYearSchema } from '@/lib/invariants/zod'`,
      `import type { SkvThing } from '@/types/skatteverket'`,
    ].join('\n')
    expect(findKernelImportsInSource(source, 'lib/core/bookkeeping/x.ts')).toEqual([])
  })

  it('counts type-position import() and import = require()', () => {
    const source = [
      `type Share = import('@/lib/invoices/customer-share').CustomerShare`,
      `import rounding = require('@/lib/bokslut/rounding')`,
    ].join('\n')
    expect(findKernelImportsInSource(source, 'lib/core/bookkeeping/x.ts')).toEqual([
      'lib/bokslut/rounding',
      'lib/invoices/customer-share',
    ])
  })

  it('isInnerModule: a trailing slash covers a directory, anything else one module', () => {
    expect(isInnerModule('lib/core')).toBe(true)
    expect(isInnerModule('lib/core/bookkeeping/period-service')).toBe(true)
    expect(isInnerModule('types')).toBe(true)
    expect(isInnerModule('lib/events')).toBe(true)
    expect(isInnerModule('lib/company/entity-type')).toBe(true)
    expect(isInnerModule('lib/company/entity-type/extra')).toBe(false)
    expect(isInnerModule('lib/company')).toBe(false)
    expect(isInnerModule('lib/money-extra')).toBe(false)
    expect(isInnerModule('lib/core-extra')).toBe(false)
  })
})

describe('ratchet comparison', () => {
  it('counts findings per file', () => {
    expect(countByFile([{ file: 'b.ts' }, { file: 'a.ts' }, { file: 'b.ts' }])).toEqual({ 'a.ts': 1, 'b.ts': 2 })
  })

  it('fails a grown file and a new file, reports a shrunk or gone file as progress', () => {
    const { grown, shrunk } = compareFileCounts(
      { 'kept.ts': 3, 'grew.ts': 1, 'shrank.ts': 4, 'gone.ts': 2 },
      { 'kept.ts': 3, 'grew.ts': 2, 'shrank.ts': 1, 'new.ts': 1 },
    )
    expect(grown).toEqual([
      { file: 'grew.ts', baseline: 1, current: 2 },
      { file: 'new.ts', baseline: 0, current: 1 },
    ])
    expect(shrunk).toEqual([
      { file: 'shrank.ts', baseline: 4, current: 1 },
      { file: 'gone.ts', baseline: 2, current: 0 },
    ])
  })

  it('fails a new kernel import edge even when an old one was removed in the same change', () => {
    const { added, removed } = compareFileEdges(
      { 'lib/core/a.ts': ['lib/invoices/x', 'lib/reports/y'] },
      { 'lib/core/a.ts': ['lib/reports/y', 'lib/salary/z'], 'lib/core/b.ts': ['lib/api/w'] },
    )
    expect(added).toEqual([
      { file: 'lib/core/a.ts', module: 'lib/salary/z' },
      { file: 'lib/core/b.ts', module: 'lib/api/w' },
    ])
    expect(removed).toEqual([{ file: 'lib/core/a.ts', module: 'lib/invoices/x' }])
  })
})

describe('end to end over a tree', () => {
  it('skips tests, exempts SE pack territory (not the form registry) for BAS and conversion code for SEK, and scans only the kernel for imports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jurisdiction-welds-'))
    tempDirs.push(root)
    const write = (rel: string, body: string) => {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    write('lib/invoices/x.ts', `const a = 1\nconst bank = '1930'\nif (c === 'SEK') {}\n`)
    write('components/y.tsx', `if (acc.startsWith('26')) {}\n`)
    write('lib/reports/ink2/engine.ts', `const r = '7201'\nif (c === 'SEK') {}\n`)
    write('lib/bokslut/tax.ts', `const tax = '8910'\n`)
    write('lib/company/forms/se-aktiebolag.ts', `const equity = '2081'\n`)
    write('lib/company/forms/index.ts', `const equity = '2081'\n`)
    write('lib/currency/rates.ts', `if (c === 'SEK') return 1\nconst bank = '1930'\n`)
    write('lib/invoices/__tests__/x.test.ts', `const bank = '1930'\nif (c === 'SEK') {}\n`)
    write('lib/invoices/y.test.ts', `const bank = '1930'\n`)
    write('scripts/z.ts', `const bank = '1930'\n`)
    write('lib/core/bookkeeping/svc.ts', `import { a } from '@/lib/invoices/x'\nimport { b } from './sibling'\n`)
    write('lib/invoices/importer.ts', `import { r } from '@/lib/reports/trial-balance'\n`)

    const welds = findJurisdictionWelds(root)
    expect(welds.basAccountLiteral).toEqual([
      { file: 'components/y.tsx', line: 1, kind: 'prefix-startsWith', match: `.startsWith('26')` },
      { file: 'lib/company/forms/index.ts', line: 1, kind: 'literal', match: `'2081'` },
      { file: 'lib/currency/rates.ts', line: 2, kind: 'literal', match: `'1930'` },
      { file: 'lib/invoices/x.ts', line: 2, kind: 'literal', match: `'1930'` },
    ])
    expect(welds.sekLiteral).toEqual([
      { file: 'lib/invoices/x.ts', line: 3, match: `=== 'SEK'` },
      { file: 'lib/reports/ink2/engine.ts', line: 2, match: `=== 'SEK'` },
    ])
    expect(welds.kernelImports).toEqual({ 'lib/core/bookkeeping/svc.ts': ['lib/invoices/x'] })
  })
})

describe('the named lists point at code that exists', () => {
  // A territory entry whose directory was moved would silently stop
  // exempting anything, and the moved code would start failing as "new".
  it.each([...SE_PACK_TERRITORY, ...CURRENCY_CONVERSION_CODE, ...KERNEL_FILES])('%s', (entry) => {
    expect(fs.existsSync(path.join(SRC, entry))).toBe(true)
  })

  it.each(KERNEL_INNER_MODULES)('kernel inner module %s', (entry) => {
    // A directory entry must be a directory; a module entry must be one file
    // (or a directory's index), or it would silently cover nothing.
    const candidates = entry.endsWith('/') ? [entry] : [`${entry}.ts`, `${entry}/index.ts`]
    expect(candidates.some((c) => fs.existsSync(path.join(SRC, c)))).toBe(true)
    if (entry.endsWith('/')) expect(fs.statSync(path.join(SRC, entry)).isDirectory()).toBe(true)
  })
})
