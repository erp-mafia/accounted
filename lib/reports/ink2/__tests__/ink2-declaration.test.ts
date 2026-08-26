/**
 * Integration tests for generateINK2Declaration.
 *
 * These cover the state the engine is actually used in: a CLOSED fiscal year.
 * INK2 is filed after bokslut, so the resultatavslut has already zeroed every
 * P&L account against 2099. The engine previously summed journal entries raw,
 * which made the whole resultaträkning collapse to zero (and INK2S with it)
 * while the balance sheet still tied out, so nothing warned. The old test file
 * only exercised the mapping table, never a closed period.
 *
 * The trial balance is mocked so the fixture can plant deterministic balances:
 * the pre-closing view feeds the income statement, the closed view the balance
 * sheet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  loadTaxAdjustmentSnapshot: vi.fn(),
}))

import { generateINK2Declaration } from '../ink2-engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import type { TrialBalanceRow } from '@/types'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'
const CLOSING_ENTRY_ID = 'closing-entry-1'

/** Build a trial balance row from a debit-positive balance. */
function row(accountNumber: string, accountName: string, balance: number): TrialBalanceRow {
  const debit = balance > 0 ? balance : 0
  const credit = balance < 0 ? -balance : 0
  return {
    account_number: accountNumber,
    account_name: accountName,
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: debit,
    closing_credit: credit,
  }
}

/**
 * Synthetic AB, first fiscal year, closed.
 *
 * Rörelseresultat      700 000 − 100 000        = 600 000
 * Finansiella poster     5 000 −   3 000        =   2 000
 * Efter finansiella                             = 602 000
 * Periodiseringsfond                  −100 000  = 502 000
 * Skatt                                −60 000  = 442 000
 *
 * 1630 carries a credit (skatteskuld presented as a negative fordran) and
 * 2641 a debit (momsfordran presented as a negative skuld): both must be
 * reclassified by sign.
 */
const PRE_CLOSING_ROWS: TrialBalanceRow[] = [
  row('1630', 'Avräkning skatter och avgifter', -20_000),
  row('1930', 'Företagskonto', 610_000),
  row('2081', 'Aktiekapital', -25_000),
  row('2099', 'Årets resultat', 0),
  row('2125', 'Periodiseringsfond', -100_000),
  row('2440', 'Leverantörsskulder', -15_000),
  row('2512', 'Beräknad inkomstskatt', -60_000),
  row('2518', 'Betald F-skatt', 50_000),
  row('2641', 'Debiterad ingående moms', 2_000),
  row('3001', 'Försäljning', -700_000),
  row('5010', 'Lokalhyra', 100_000),
  row('8311', 'Ränteintäkter', -5_000),
  row('8410', 'Räntekostnader', 3_000),
  row('8811', 'Avsättning till periodiseringsfond', 100_000),
  row('8910', 'Skatt på årets resultat', 60_000),
]

/** Same year after the resultatavslut: P&L zeroed, 2099 carries the result. */
const CLOSED_ROWS: TrialBalanceRow[] = PRE_CLOSING_ROWS.map((r) => {
  if (r.account_number === '2099') return row('2099', 'Årets resultat', -442_000)
  if (Number(r.account_number[0]) >= 3) return row(r.account_number, r.account_name, 0)
  return r
})

interface SupabaseStub {
  from: (table: string) => unknown
}

function makeSupabase(options?: {
  closingEntryId?: string | null
  closingEntryStatus?: string
  isClosed?: boolean
}): SupabaseStub {
  const closingEntryId =
    options?.closingEntryId === undefined ? CLOSING_ENTRY_ID : options.closingEntryId

  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: PERIOD_ID,
                    name: 'Räkenskapsår 1',
                    period_start: '2025-01-01',
                    period_end: '2025-12-31',
                    is_closed: options?.isClosed ?? true,
                    closing_entry_id: closingEntryId,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'company_settings') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  company_name: 'Testbolaget AB',
                  org_number: '5560000000',
                  entity_type: 'aktiebolag',
                  address_line1: 'Testgatan 1',
                  postal_code: '11122',
                  city: 'Stockholm',
                  email: 'test@example.com',
                },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'journal_entries') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: closingEntryId
                    ? { status: options?.closingEntryStatus ?? 'posted' }
                    : null,
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anySupabase = (stub: SupabaseStub) => stub as any

function stubTrialBalances(closed: TrialBalanceRow[], preClosing: TrialBalanceRow[]) {
  vi.mocked(generateTrialBalance).mockImplementation(
    async (_supabase, _companyId, _periodId, opts) => ({
      rows: opts.closingEntry === 'exclude-final' ? preClosing : closed,
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue({
    nonDeductibleExpenses: 4_000,
    nonTaxableIncome: 0,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  stubTrialBalances(CLOSED_ROWS, PRE_CLOSING_ROWS)
})

describe('generateINK2Declaration: closed fiscal year', () => {
  it('reads the income statement from the pre-closing books', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    // The regression: every one of these was 0 when the resultatavslut was
    // summed into the P&L accounts.
    expect(result.ink2r['7410']).toBe(700_000)
    expect(result.ink2r['7513']).toBe(100_000)
    expect(result.ink2r['7417']).toBe(5_000)
    expect(result.ink2r['7522']).toBe(3_000)
    expect(result.ink2r['7525']).toBe(100_000)
    expect(result.ink2r['7528']).toBe(60_000)
    expect(result.ink2r['7450']).toBe(442_000)
    expect(result.ink2r['7550']).toBe(0)
  })

  it('computes the result subtotals', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.totals.operatingResult).toBe(600_000)
    expect(result.totals.aretsResultat).toBe(442_000)
  })

  it('reads the balance sheet from the closed books so 7302 carries the result', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.ink2r['7302']).toBe(442_000)
    expect(result.ink2r['7301']).toBe(25_000)
    expect(result.ink2r['7321']).toBe(100_000)
  })

  it('does not double-count årets resultat in equity', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    // 2099 already holds 442 000. Adding resultAfterFinancial on top would
    // report 1 054 000 and raise a bogus imbalance warning.
    expect(result.totals.totalEquityLiabilities).toBe(612_000)
    expect(result.totals.totalAssets).toBe(612_000)
    expect(result.warnings.some((w) => w.includes('inte i balans'))).toBe(false)
  })

  it('derives INK2S from the restored result', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.ink2s['7650']).toBe(442_000)
    expect(result.ink2s['7750']).toBe(0)
    expect(result.ink2s['7651']).toBe(60_000)
    expect(result.ink2s['7653']).toBe(4_000)
    // 442 000 + 60 000 + 4 000
    expect(result.ink2s['8020']).toBe(506_000)
    expect(result.ink2s['8021']).toBe(0)
    expect(result.ink2['7104']).toBe(506_000)
  })

  it('does not re-add the periodiseringsfond, which is already in the result', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    // 7525 appears on INK2R as a bokslutsdisposition but must not inflate the
    // taxable result: it already reduced årets resultat.
    expect(result.ink2r['7525']).toBe(100_000)
    expect(result.ink2s['8020']).toBe(506_000)
  })
})

describe('generateINK2Declaration: sign-based reclassification', () => {
  it('presents a skattekonto credit as a skatteskuld, not a negative fordran', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    // 2512 − 2518 = 10 000, plus the reclassified 1630 credit of 20 000.
    expect(result.ink2r['7368']).toBe(30_000)
    expect(result.ink2r['7261']).toBeGreaterThanOrEqual(0)
  })

  it('presents an input-VAT debit as a fordran, not a negative skuld', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.ink2r['7261']).toBe(2_000)
    expect(result.ink2r['7369']).toBe(0)
  })

  it('moves the account rows so the breakdown matches the post totals', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    const codes = ['7261', '7368', '7369'] as const
    for (const code of codes) {
      const sum = result.breakdown[code].accounts.reduce((s, a) => s + a.amount, 0)
      expect(sum).toBe(result.ink2r[code])
    }
    expect(result.breakdown['7368'].accounts.map((a) => a.accountNumber)).toContain('1630')
    expect(result.breakdown['7261'].accounts.map((a) => a.accountNumber)).toContain('2641')
    expect(result.breakdown['7261'].accounts.map((a) => a.accountNumber)).not.toContain('1630')
  })

  it('warns about each reclassification it performed', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.warnings.some((w) => w.includes('1630-1659'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('2610-2659'))).toBe(true)
  })

  it('leaves normally-signed accounts alone and stays silent', async () => {
    const normal = PRE_CLOSING_ROWS.map((r) => {
      if (r.account_number === '1630') return row('1630', 'Skattekonto', 20_000)
      if (r.account_number === '2641') return row('2641', 'Ingående moms', -2_000)
      return r
    })
    stubTrialBalances(normal, normal)

    const result = await generateINK2Declaration(
      anySupabase(makeSupabase({ closingEntryId: null, isClosed: false })),
      COMPANY_ID,
      PERIOD_ID,
    )

    expect(result.ink2r['7261']).toBe(20_000)
    expect(result.ink2r['7369']).toBe(2_000)
    expect(result.warnings.some((w) => w.includes('1630-1659'))).toBe(false)
    expect(result.warnings.some((w) => w.includes('2610-2659'))).toBe(false)
  })
})

describe('generateINK2Declaration: open fiscal year', () => {
  beforeEach(() => {
    // No resultatavslut yet: both views are identical and 2099 is empty.
    stubTrialBalances(PRE_CLOSING_ROWS, PRE_CLOSING_ROWS)
  })

  it('still adds the computed result to equity so the balance sheet ties out', async () => {
    const result = await generateINK2Declaration(
      anySupabase(makeSupabase({ closingEntryId: null, isClosed: false })),
      COMPANY_ID,
      PERIOD_ID,
    )

    expect(result.ink2r['7302']).toBe(0)
    expect(result.totals.totalAssets).toBe(612_000)
    expect(result.totals.totalEquityLiabilities).toBe(612_000)
    expect(result.warnings.some((w) => w.includes('inte i balans'))).toBe(false)
  })

  it('warns that the year is not closed', async () => {
    const result = await generateINK2Declaration(
      anySupabase(makeSupabase({ closingEntryId: null, isClosed: false })),
      COMPANY_ID,
      PERIOD_ID,
    )

    expect(result.warnings.some((w) => w.includes('inte stängt'))).toBe(true)
  })

  it('treats a reversed closing entry as not closed into equity', async () => {
    // Undo year-end stornoes the closing entry: it nets to zero against its
    // storno, so the result is back in the P&L accounts.
    const result = await generateINK2Declaration(
      anySupabase(makeSupabase({ closingEntryStatus: 'reversed', isClosed: false })),
      COMPANY_ID,
      PERIOD_ID,
    )

    expect(result.totals.totalEquityLiabilities).toBe(612_000)
    expect(result.warnings.some((w) => w.includes('inte i balans'))).toBe(false)
  })
})

describe('generateINK2Declaration: guards', () => {
  it('rejects a non-aktiebolag', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'company_settings') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { entity_type: 'enskild_firma' },
                  error: null,
                }),
              }),
            }),
          }
        }
        return makeSupabase().from(table)
      },
    }

    await expect(
      generateINK2Declaration(anySupabase(supabase), COMPANY_ID, PERIOD_ID),
    ).rejects.toThrow(/aktiebolag/i)
  })

  it('warns about a BAS account with no SRU mapping', async () => {
    const withUnmapped = [
      ...PRE_CLOSING_ROWS,
      row('1305', 'Okänt konto', 1_000),
    ]
    stubTrialBalances(withUnmapped, withUnmapped)

    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.warnings.some((w) => w.includes('1305'))).toBe(true)
  })

  it('does not warn about an unmapped account with no balance', async () => {
    const withUnmapped = [...PRE_CLOSING_ROWS, row('1305', 'Okänt konto', 0)]
    stubTrialBalances(withUnmapped, withUnmapped)

    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.warnings.some((w) => w.includes('1305'))).toBe(false)
  })
})

describe('generateINK2Declaration: cross-surface self-check', () => {
  it('warns when the declared result disagrees with the booked 2099', async () => {
    // Exactly the shape a customer reported on 2026-07-29: the form said
    // 0 kr while the books carried 442 000 kr on 2099. Nothing warned then,
    // because the balance sheet still tied out on its own.
    const zeroedIncome = CLOSED_ROWS
    stubTrialBalances(CLOSED_ROWS, zeroedIncome)

    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.ink2r['7450']).toBe(0)
    expect(result.warnings.some((w) => w.includes('stämmer inte med det bokförda resultatet'))).toBe(true)
  })

  it('stays silent when the declaration agrees with the books', async () => {
    const result = await generateINK2Declaration(anySupabase(makeSupabase()), COMPANY_ID, PERIOD_ID)

    expect(result.ink2r['7450']).toBe(442_000)
    expect(result.warnings.some((w) => w.includes('stämmer inte med det bokförda resultatet'))).toBe(false)
  })

  it('does not fire on an open year, where 2099 is legitimately empty', async () => {
    stubTrialBalances(PRE_CLOSING_ROWS, PRE_CLOSING_ROWS)

    const result = await generateINK2Declaration(
      anySupabase(makeSupabase({ closingEntryId: null, isClosed: false })),
      COMPANY_ID,
      PERIOD_ID,
    )

    expect(result.warnings.some((w) => w.includes('stämmer inte med det bokförda resultatet'))).toBe(false)
  })
})
