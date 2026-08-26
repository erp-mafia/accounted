import { describe, expect, it } from 'vitest'
import { parseSIEFile } from '../sie-parser'
import { mergeParsedSIEFiles } from '../sie-merge'
import { generateImportPreview } from '../sie-import'
import { buildTheaterModel } from '../theater-model'
import type { AccountMapping } from '../types'

/**
 * One provider-style SIE 4 export per fiscal year, like the files
 * fetchProviderSieFiles returns (oldest first).
 */
function sieYear(opts: {
  year: number
  companyName?: string
  konto?: string[]
  vouchers?: string[][]
  extra?: string[]
}): string {
  const { year, companyName = 'One Punkt Com AB', konto = [], vouchers = [], extra = [] } = opts
  return [
    '#FLAGGA 0',
    '#SIETYP 4',
    `#FNAMN "${companyName}"`,
    '#ORGNR 5566778899',
    `#RAR 0 ${year}0101 ${year}1231`,
    `#RAR -1 ${year - 1}0101 ${year - 1}1231`,
    '#KONTO 1930 "Företagskonto"',
    '#KONTO 2641 "Ingående moms"',
    ...konto,
    ...extra,
    ...vouchers.flat(),
  ].join('\n')
}

function voucher(num: number, date: string, description: string, account: string, amount = 100): string[] {
  return [
    `#VER A ${num} ${date} "${description}"`,
    '{',
    `#TRANS ${account} {} ${amount}.00`,
    `#TRANS 1930 {} -${amount}.00`,
    '}',
  ]
}

describe('mergeParsedSIEFiles', () => {
  it('throws on an empty list and passes a single file through unchanged', () => {
    expect(() => mergeParsedSIEFiles([])).toThrow()
    const parsed = parseSIEFile(sieYear({ year: 2026 }))
    expect(mergeParsedSIEFiles([parsed])).toBe(parsed)
  })

  it('merges distinct years: vouchers concatenated, fiscal years union oldest first', () => {
    const y2024 = parseSIEFile(
      sieYear({
        year: 2024,
        konto: ['#KONTO 4010 "Material"'],
        vouchers: [voucher(1, '20240315', 'Bolagsverket', '4010'), voucher(2, '20240601', 'Loopia', '4010')],
      }),
    )
    const y2025 = parseSIEFile(
      sieYear({
        year: 2025,
        konto: ['#KONTO 3041 "Försäljning tjänster"'],
        vouchers: [voucher(1, '20250210', 'Kund AB', '3041', 250)],
      }),
    )
    const y2026 = parseSIEFile(sieYear({ year: 2026 }))

    const merged = mergeParsedSIEFiles([y2024, y2025, y2026])

    expect(merged.vouchers).toHaveLength(3)
    expect(merged.stats.totalVouchers).toBe(3)
    expect(merged.stats.totalTransactionLines).toBe(6)
    // Union of #RAR periods: 2023 (from y2024's #RAR -1) through 2026,
    // oldest first, newest re-indexed to yearIndex 0.
    expect(merged.header.fiscalYears.map((fy) => fy.start)).toEqual([
      '2023-01-01',
      '2024-01-01',
      '2025-01-01',
      '2026-01-01',
    ])
    expect(merged.header.fiscalYears.map((fy) => fy.yearIndex)).toEqual([-3, -2, -1, 0])
    expect(merged.stats.fiscalYearStart).toBe('2026-01-01')
    expect(merged.stats.fiscalYearEnd).toBe('2026-12-31')
    // Accounts are a union across files.
    expect(merged.accounts.map((a) => a.number).sort()).toEqual(['1930', '2641', '3041', '4010'])
    expect(merged.stats.totalAccounts).toBe(4)
    expect(merged.header.companyName).toBe('One Punkt Com AB')
    expect(merged.header.orgNumber).toBe('5566778899')
  })

  it('dedupes duplicate account numbers: first name wins, later files fill missing metadata', () => {
    const older = parseSIEFile(
      sieYear({ year: 2024, konto: ['#KONTO 4010 "Material och varor"'] }),
    )
    const newer = parseSIEFile(
      sieYear({
        year: 2025,
        konto: ['#KONTO 4010 "Inköp material"'],
        extra: ['#SRU 4010 7512'],
      }),
    )

    const merged = mergeParsedSIEFiles([older, newer])

    const acc = merged.accounts.filter((a) => a.number === '4010')
    expect(acc).toHaveLength(1)
    expect(acc[0].name).toBe('Material och varor')
    // The older file had no #SRU for 4010: the newer file's code fills it in.
    expect(acc[0].sruCode).toBe('7512')
  })

  it('an empty newest file plus a rich older file yields a rich merge', () => {
    const rich = parseSIEFile(
      sieYear({
        year: 2025,
        konto: ['#KONTO 4010 "Material"', '#KONTO 3041 "Försäljning tjänster"'],
        vouchers: [
          voucher(1, '20250110', 'Loopia', '4010'),
          voucher(2, '20250211', 'Loopia', '4010'),
          voucher(3, '20250320', 'Kund AB', '3041', 900),
        ],
        extra: ['#IB 0 1930 5000.00', '#IB 0 2081 -5000.00'],
      }),
    )
    // Mid-year export: the newest fiscal year has accounts but zero vouchers.
    const empty = parseSIEFile(sieYear({ year: 2026 }))

    const merged = mergeParsedSIEFiles([rich, empty])

    expect(merged.stats.totalVouchers).toBe(3)
    expect(merged.openingBalances).toHaveLength(2)

    // The preview built from the merge reports the whole dataset, not the
    // empty newest file (the "Hittade 740 konton och 0 verifikationer" bug).
    const mappings: AccountMapping[] = []
    const preview = generateImportPreview(merged, mappings)
    expect(preview.voucherCount).toBe(3)
    // 1930, 2641, 4010, 3041 from #KONTO plus 2081 auto-registered from #IB.
    expect(preview.accountCount).toBe(5)

    // The theater model gets the full history: both years, real accounts,
    // a counterparty seen twice.
    const model = buildTheaterModel(merged)
    expect(model.totalVouchers).toBe(3)
    expect(model.years.length).toBeGreaterThanOrEqual(2)
    expect(model.accounts.length).toBeGreaterThan(0)
    expect(model.counterparties.map((c) => c.name)).toContain('Loopia')
  })

  it('keeps the most common non-empty company name and concatenates issues', () => {
    const a = parseSIEFile(sieYear({ year: 2024, companyName: 'Gamla Namnet AB' }))
    const b = parseSIEFile(sieYear({ year: 2025, companyName: 'One Punkt Com AB' }))
    const c = parseSIEFile(sieYear({ year: 2026, companyName: 'One Punkt Com AB' }))

    const merged = mergeParsedSIEFiles([a, b, c])
    expect(merged.header.companyName).toBe('One Punkt Com AB')
    expect(merged.issues).toEqual([...a.issues, ...b.issues, ...c.issues])
  })

  it('dedupes dimension registrations by number and (number, code)', () => {
    const dims = [
      '#DIM 6 "Projekt"',
      '#OBJEKT 6 "P1" "Bryggan"',
    ]
    const a = parseSIEFile(sieYear({ year: 2024, extra: dims }))
    const b = parseSIEFile(
      sieYear({ year: 2025, extra: [...dims, '#OBJEKT 6 "P2" "Kajen"'] }),
    )

    const merged = mergeParsedSIEFiles([a, b])
    expect(merged.dimensions).toHaveLength(1)
    expect(merged.dimensionValues.map((v) => v.code).sort()).toEqual(['P1', 'P2'])
  })
})
