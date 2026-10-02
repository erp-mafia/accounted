/**
 * #3312: a Fortnox year with amounts on class 9 was refused on every provider
 * retry with SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS, while the same file went
 * through the file upload. The class 9 rule (class 9 amounts to 2999
 * OBS-konto) ran only in the upload's parse route; the provider fetch built
 * its mappings with suggestMappings alone, so a 9xxx target reached the job
 * in each of three ways: a stored 9xxx mapping from the earlier year's
 * import, the company chart's own 9xxx row, or the onboarding step's
 * self-map of a blank target.
 *
 * suggestSIEMappings is now the one decision both paths run. Pinned here on
 * a Fortnox-shaped two-year dataset: FY2025 carries the class 9 definitions
 * unused, FY2026 carries hour-statistics pairs inside class 9 plus one 9999
 * OBS posting against the bank.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { suggestMappings, isSystemAccount, type MappableAccount } from '../account-mapper'
import { suggestSIEMappings } from '../sie-preview-mappings'
import { parseSIEFile } from '../sie-parser'
import { mergeParsedSIEFiles } from '../sie-merge'
import { SIEJobValidationError, validateSIEJobInput } from '../sie-jobs'
import { importVouchers } from '../sie-import'
import type { AccountMapping, SIEAccountMappingRecord } from '../types'

const CHART = [
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2099 "Årets resultat"',
  '#KONTO 3001 "Försäljning tjänster"',
  '#KONTO 9000 "Debiterbar tid"',
  '#KONTO 9010 "Motkonto tid"',
  '#KONTO 9999 "OBS-konto"',
]

const FY2025 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"',
  '#RAR 0 20250101 20251231', ...CHART,
  '#VER A 1 20250115 "Faktura 1"', '{', '#TRANS 1930 {} 1000.00', '#TRANS 3001 {} -1000.00', '}',
].join('\n')

const FY2026 = [
  '#FLAGGA 0', '#PROGRAM "Fortnox" 3.0', '#SIETYP 4', '#FNAMN "Konsultbolaget AB"',
  '#RAR 0 20260101 20261231', '#RAR -1 20250101 20251231', ...CHART,
  '#IB 0 1930 1000.00', '#IB 0 2099 -1000.00',
  // Hour statistics only: an internal pair, nothing in classes 1-8.
  '#VER A 1 20260110 "Tidrapport vecka 2"', '{', '#TRANS 9000 {} 4000.00', '#TRANS 9010 {} -4000.00', '}',
  // An invoice that also carries its hours.
  '#VER A 2 20260131 "Faktura 2"', '{', '#TRANS 1930 {} 2500.00', '#TRANS 3001 {} -2500.00',
  '#TRANS 9000 {} 1200.00', '#TRANS 9010 {} -1200.00', '}',
  // An unidentified payment parked on the OBS-konto: a real counterpart.
  '#VER A 3 20260215 "Okänd inbetalning"', '{', '#TRANS 1930 {} 500.00', '#TRANS 9999 {} -500.00', '}',
  '#RES 0 3001 -2500.00', '#RES 0 9000 5200.00', '#RES 0 9010 -5200.00',
].join('\n')

const OPTIONS = { filename: 'fy2026.se', createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true }
const CLASS_9 = ['9000', '9010', '9999']

/** What an earlier provider import saved: the onboarding step self-mapped 9xxx. */
const STORED_SELF_MAPS: SIEAccountMappingRecord[] = CLASS_9.map((number) => ({
  id: `m-${number}`, user_id: 'user-1', source_account: number, source_name: '', target_account: number,
  confidence: 1, match_type: 'exact', created_at: '', updated_at: '',
}))

/** The chart the earlier year's import left behind: it kept the unused 9xxx definitions (#2605). */
const CHART_WITH_CLASS_9: MappableAccount[] = [
  { account_number: '9000', account_name: 'Debiterbar tid' },
  { account_number: '9010', account_name: 'Motkonto tid' },
  { account_number: '9999', account_name: 'OBS-konto' },
]

/** The provider fetch's inputs: the company chart first, then BAS (lib/mapping-targets). */
function providerTargets(chart: MappableAccount[]): MappableAccount[] {
  const own = new Set(chart.map((a) => a.account_number))
  return [...chart, ...BAS_REFERENCE.filter((a) => !own.has(a.account_number))]
}

/** /sie-data: the merged dataset, system accounts filtered out of the account list. */
function providerDecision(chart: MappableAccount[], stored?: SIEAccountMappingRecord[]) {
  const merged = mergeParsedSIEFiles([parseSIEFile(FY2025), parseSIEFile(FY2026)])
  const accounts = merged.accounts.filter((a) => !isSystemAccount(a.number))
  return suggestSIEMappings(merged, providerTargets(chart), stored, accounts).mappings
}

/** /api/import/sie/parse: the one file, against BAS. */
function uploadDecision(stored?: SIEAccountMappingRecord[]) {
  return suggestSIEMappings(parseSIEFile(FY2026), BAS_REFERENCE, stored).mappings
}

async function prepare(mappings: AccountMapping[]) {
  const accountMap = new Map(mappings.map((m) => [m.sourceAccount, m.targetAccount]))
  const accountIds = new Map([...new Set(accountMap.values())].map((n) => [n, `acc-${n}`]))
  return importVouchers({} as SupabaseClient, 'company-1', 'user-1', 'period-1', parseSIEFile(FY2026),
    accountMap, 'A', 'import-1', { startOrdinal: 0, only: true, hasCurrentYearIb: true, accountIds })
}

const target = (mappings: AccountMapping[], source: string) => mappings.find((m) => m.sourceAccount === source)?.targetAccount

const STATES = [
  ['a stored 9xxx mapping from the earlier import', [] as MappableAccount[], STORED_SELF_MAPS],
  ['9xxx rows already in the company chart', CHART_WITH_CLASS_9, undefined],
  ['neither (the target used to be left blank)', [] as MappableAccount[], undefined],
] as const

describe('#3312: the class 9 decision on every entry', () => {
  it('reproduces the refusal: suggestMappings alone hands the job a 9xxx target', () => {
    const merged = mergeParsedSIEFiles([parseSIEFile(FY2025), parseSIEFile(FY2026)])
    const before = suggestMappings(merged.accounts, providerTargets([]), STORED_SELF_MAPS)
    expect(target(before, '9999')).toBe('9999')
    let thrown: unknown
    try { validateSIEJobInput(FY2026, parseSIEFile(FY2026), SIEJobMappingsSchema.parse(before), OPTIONS) } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(SIEJobValidationError)
    expect((thrown as SIEJobValidationError).code).toBe('SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS')
  })

  it.each(STATES)('the provider fetch sends class 9 amounts to 2999 with %s', (_label, chart, stored) => {
    const mappings = providerDecision(chart, stored)
    for (const number of CLASS_9) {
      expect(mappings.find((m) => m.sourceAccount === number)).toMatchObject({ targetAccount: '2999', matchType: 'class' })
    }
    // The job accepts what the fetch now returns, for the year that was refused.
    expect(() => validateSIEJobInput(FY2026, parseSIEFile(FY2026), SIEJobMappingsSchema.parse(mappings), OPTIONS)).not.toThrow()
  })

  it.each(STATES)('both paths prepare the same balanced verifikat with %s', async (_label, chart, stored) => {
    const provider = await prepare(providerDecision(chart, stored))
    const upload = await prepare(uploadDecision(stored))

    // Nothing skipped, the source numbering kept, and the same lines either way.
    expect(provider.skippedDetails).toEqual([])
    expect(upload.skippedDetails).toEqual([])
    const shape = (r: typeof provider) => (r.preparedEntries ?? []).map((e) => ({ id: e.sourceId, lines: e.lines.map((l) =>
      [l.account_number, l.debit_amount, l.credit_amount]) }))
    expect(shape(provider)).toEqual(shape(upload))
    expect(shape(provider).map((e) => e.id)).toEqual(['A1', 'A2', 'A3'])

    for (const entry of provider.preparedEntries ?? []) {
      const debit = entry.lines.reduce((s, l) => Math.round((s + l.debit_amount) * 100) / 100, 0)
      const credit = entry.lines.reduce((s, l) => Math.round((s + l.credit_amount) * 100) / 100, 0)
      expect(debit).toBe(credit)
      expect(debit).toBeGreaterThan(0)
      expect(entry.lines.every((l) => /^[1-8]\d{3}$/.test(l.account_number))).toBe(true)
    }
    // The OBS posting keeps its amount and its counterpart.
    expect(shape(provider).find((e) => e.id === 'A3')?.lines).toEqual([['1930', 500, 0], ['2999', 0, 500]])
  })

  it('still keeps an unused class 9 definition under its own number (#2605)', () => {
    const merged = mergeParsedSIEFiles([parseSIEFile(FY2025)])
    const mappings = suggestSIEMappings(merged, providerTargets([]), STORED_SELF_MAPS).mappings
    for (const number of CLASS_9) expect(target(mappings, number)).toBe(number)
  })
})
