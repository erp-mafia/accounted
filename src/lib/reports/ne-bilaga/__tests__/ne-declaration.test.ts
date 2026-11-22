/**
 * Integration tests for generateNEDeclaration against a CLOSED fiscal year.
 *
 * R1-R11 are an income statement. The resultatavslut zeroes every P&L account
 * at year-end, and NE-bilaga is always filed after bokslut, so a raw journal
 * scan reported an empty näringsverksamhet. The old test file only exercised
 * the mapping table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateNEDeclaration } from '../ne-engine'
import { generateNESRUSubmission, NESruBlockedError } from '../sru-generator'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { TrialBalanceRow } from '@/types'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'

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

/** Pre-closing books: revenue 400 000, costs 150 000, result 250 000. */
const PRE_CLOSING_ROWS: TrialBalanceRow[] = [
  row('1930', 'Företagskonto', 250_000),
  row('3001', 'Försäljning', -400_000),
  row('5010', 'Lokalhyra', 120_000),
  row('6110', 'Kontorsmateriel', 30_000),
]

function makeSupabase() {
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
                    name: 'Räkenskapsår 2025',
                    period_start: '2025-01-01',
                    period_end: '2025-12-31',
                    is_closed: true,
                    closing_entry_id: 'closing-entry-1',
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
                  company_name: 'Testfirman',
                  org_number: '199001010000',
                  entity_type: 'enskild_firma',
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
      if (table === 'fiscal_period_tax_adjustments') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: savedAdjustments, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

/** The year's saved tax-adjustment rows the stub answers; none unless a test sets them. */
let savedAdjustments: Array<Record<string, unknown>> = []
beforeEach(() => {
  savedAdjustments = []
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: PRE_CLOSING_ROWS,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  })
})

describe('generateNEDeclaration: sida 2 R12-R14 from the tax adjustments', () => {
  // Skatteverket, "Skattemässiga justeringar" (NE-bilagan): R13 takes back
  // representation, föreningsavgifter, böter and the skattekonto's
  // kostnadsränta; R14 takes out its inkomstränta.
  const ADJUSTED_ROWS: TrialBalanceRow[] = [
    ...PRE_CLOSING_ROWS,
    row('6072', 'Representation, ej avdragsgill', 4_000.6),
    row('8423', 'Räntekostnader för skatter och avgifter', 120),
    row('8314', 'Skattefria ränteintäkter', -49),
  ]

  it('adds back representation and kostnadsränta on R13, takes out the inkomstränta on R14, and files both', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: ADJUSTED_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    // 4 000,60 + 120 kr, öre truncated (SFL 22 kap. 1 §).
    expect(result.sida2).toEqual({ R12: result.rutor.R11, R13: 4_120, R14: 49 })
    expect(result.sida2Breakdown.R13.items.map((item) => item.accountNumber)).toEqual(['6072', '8423'])
    expect(result.sida2Breakdown.R14.items.map((item) => item.accountNumber)).toEqual(['8314'])
    // The books are read once: the adjustments use R1-R11's own trial balance.
    expect(vi.mocked(generateTrialBalance)).toHaveBeenCalledTimes(1)

    const { blanketterSru } = generateNESRUSubmission(result)
    expect(blanketterSru).toContain('#UPPGIFT 7601 4120')
    expect(blanketterSru).toContain('#UPPGIFT 7700 49')
  })

  it('leaves out an adjustment the owner unticked for the year', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: ADJUSTED_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true })
    savedAdjustments = [
      { source_key: 'account:6072', adjustment_type: 'non_deductible_expense', source: 'detected', description: '', account_number: '6072', amount: 4_000.6, included: false },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)
    expect(result.sida2.R13).toBe(120)
  })

  it('has nothing on R13 or R14 for books without such accounts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)
    expect(result.sida2).toEqual({ R12: result.rutor.R11, R13: 0, R14: 0 })
    const { blanketterSru } = generateNESRUSubmission(result)
    expect(blanketterSru).not.toContain('#UPPGIFT 7601')
    expect(blanketterSru).not.toContain('#UPPGIFT 7700')
  })
})

describe('generateNEDeclaration: the number it files under', () => {
  it('reads a number held only on the company row', async () => {
    const stub = makeSupabase()
    const companyRowOnly = {
      from: (table: string) => {
        if (table === 'company_settings') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { company_name: 'Testfirman', org_number: null, entity_type: 'enskild_firma' }, error: null }),
              }),
            }),
          }
        }
        if (table === 'companies') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { org_number: '800374-0118', entity_type: 'enskild_firma' }, error: null }),
              }),
            }),
          }
        }
        return stub.from(table)
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(companyRowOnly as any, COMPANY_ID, PERIOD_ID)
    expect(result.companyInfo.orgNumber).toBe('800374-0118')
  })
})

describe('generateNEDeclaration: closed fiscal year', () => {
  it('requests the pre-closing trial balance', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(vi.mocked(generateTrialBalance)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      PERIOD_ID,
      { closingEntry: 'exclude-final' },
    )
  })

  it('reports the year the resultatavslut would have zeroed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R1).toBe(400_000)
    expect(result.rutor.R6).toBe(150_000)
    expect(result.rutor.R11).toBe(250_000)
    expect(result.warnings.some((w) => w.includes('Inga bokförda intäkter'))).toBe(false)
  })
})

describe('generateNEDeclaration: R11 equals the booked result', () => {
  it('maps 6991, 7960 and 8210 so R11 equals the booked result', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('1930', 'Företagskonto', 300_000),
        row('3001', 'Försäljning', -400_000),
        row('6991', 'Övriga externa kostnader, avdragsgilla', 50_000),
        row('7960', 'Valutakursförluster', 2_000),
        row('8210', 'Utdelningar på andelar i andra företag', -1_500),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R6).toBe(50_000)
    expect(result.rutor.R8).toBe(2_000)
    expect(result.rutor.R4).toBe(1_500)
    expect(result.rutor.R11).toBe(349_500)
    expect(result.bookedResult).toBe(349_500)
    expect(result.sruBlockers).toEqual([])
    expect(() => generateNESRUSubmission(result)).not.toThrow()
  })

  it('names an account without a ruta and refuses the SRU file', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('5010', 'Lokalhyra', 100_000),
        row('8470', 'Egen räntepost', 2_500),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R11).toBe(300_000)
    expect(result.bookedResult).toBe(297_500)
    expect(result.sruBlockers).toHaveLength(1)
    expect(result.sruBlockers[0]).toContain('8470 Egen räntepost')
    expect(result.sruBlockers[0]).toContain('SRU-filen kan inte laddas ner')
    expect(result.warnings).toContain(result.sruBlockers[0])
    expect(() => generateNESRUSubmission(result)).toThrow(/8470/)
  })

  it('refuses even when unmapped accounts cancel out, since the rutor still miss them', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('7750', 'Egen kostnad', 1_000),
        row('8470', 'Egen intäkt', -1_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R11).toBe(result.bookedResult)
    expect(result.sruBlockers[0]).toMatch(/^Kontona 7750 Egen kostnad .*8470 Egen intäkt/)
    expect(result.sruBlockers[0]).not.toContain('R11 blir')
  })

  it('truncates öre toward zero in every ruta (SFL 22 kap. 1 §), not to the nearest krona', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -100_000.75),
        row('5010', 'Lokalhyra', 20_000.5),
        // Återföring av nedskrivning: a credit on a cost ruta makes R9 negative.
        row('7770', 'Återföring av nedskrivningar av byggnader', -1_000.6),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    // Rounded, these would be 100 001, 20 001 and -1 001.
    expect(result.rutor.R1).toBe(100_000)
    expect(result.rutor.R6).toBe(20_000)
    expect(result.rutor.R9).toBe(-1_000)
    expect(result.breakdown.R1.accounts[0].amount).toBe(100_000)
    expect(result.rutor.R11).toBe(81_000)
    expect(result.bookedResult).toBe(81_000.85)
    expect(result.sruBlockers).toEqual([])
    expect(generateNESRUSubmission(result).blanketterSru).toContain('#UPPGIFT 7400 100000\r\n')
  })

  it('does not block on the öre truncation of the rutor', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -100_000.4),
        row('3004', 'Momsfri försäljning', -10_000.4),
        row('5010', 'Lokalhyra', 20_000.6),
        row('6110', 'Kontorsmateriel', 1_000.6),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    // R1 100 000 + R2 10 000 - R6 21 001 (21 001,20) = 88 999; booked 88 999,60.
    expect(result.rutor.R11).toBe(88_999)
    expect(result.bookedResult).toBe(88_999.6)
    expect(result.sruBlockers).toEqual([])
  })

  it('warns by name about 88xx bokslutsdispositioner but keeps them in their ruta', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('8853', 'Förändring av överavskrivningar, maskiner respektive inventarier', 5_000),
        row('8860', 'Förändring av ersättningsfond', 10_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R8).toBe(10_000)
    expect(result.rutor.R10).toBe(5_000)
    expect(result.rutor.R11).toBe(385_000)
    expect(result.sruBlockers).toEqual([])
    expect(result.warnings.filter((w) => w.includes('bokslutsdispositioner som en enskild firma'))).toHaveLength(2)
    expect(result.warnings.some((w) => w.startsWith('Konto 8860 Förändring av ersättningsfond'))).toBe(true)
  })

  it('refuses the SRU file for a booked skatt (89xx), which is the owner\'s private tax', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('8910', 'Skatt som belastar årets resultat', 5_000),
        row('8980', 'Övriga skatter', 1_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    // Still in R8, so R11 is the booked result: only the file is refused.
    expect(result.rutor.R8).toBe(6_000)
    expect(result.rutor.R11).toBe(394_000)
    expect(result.bookedResult).toBe(394_000)
    expect(result.sruBlockers).toHaveLength(1)
    expect(result.sruBlockers[0]).toMatch(/^Kontona 8910 Skatt som belastar årets resultat .*8980 Övriga skatter .*bokför skatt som en kostnad/)
    expect(result.sruBlockers[0]).toContain('eget uttag (2013)')
    expect(result.warnings[0]).toBe(result.sruBlockers[0])
    expect(result.warnings.filter((w) => w.includes('8910'))).toHaveLength(1)
    expect(() => generateNESRUSubmission(result)).toThrow(NESruBlockedError)
  })

  it('refuses the SRU file for koncernbidrag (882x-884x), which NE_EJ_K1 gives no ruta', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('8820', 'Mottagna koncernbidrag', -50_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R4).toBe(0)
    expect(result.rutor.R11).toBe(400_000)
    expect(result.bookedResult).toBe(450_000)
    expect(result.sruBlockers).toHaveLength(1)
    expect(result.sruBlockers[0]).toMatch(/^Konto 8820 Mottagna koncernbidrag .*hör inte till någon ruta/)
    expect(() => generateNESRUSubmission(result)).toThrow(/8820/)
  })

  it('refuses the SRU file for a booked periodiseringsfond, which an enskild firma claims only on the NE', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('8811', 'Avsättning till periodiseringsfond', 100_000),
        row('8860', 'Förändring av ersättningsfond', 10_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    // Still in its BAS ruta, so R11 is the booked result: only the file is refused.
    expect(result.rutor.R8).toBe(110_000)
    expect(result.rutor.R11).toBe(290_000)
    expect(result.bookedResult).toBe(290_000)
    expect(result.sruBlockers).toHaveLength(1)
    expect(result.sruBlockers[0]).toMatch(/^Konto 8811 Avsättning till periodiseringsfond .*bokför en periodiseringsfond/)
    expect(result.warnings[0]).toBe(result.sruBlockers[0])
    // Ersättningsfond is booked by an enskild firma too: a warning, never a blocker.
    expect(result.warnings.some((w) => w.startsWith('Konto 8860'))).toBe(true)
    expect(result.warnings.filter((w) => w.startsWith('Konto 8811'))).toHaveLength(1)
    expect(() => generateNESRUSubmission(result)).toThrow(NESruBlockedError)
  })

  it('leaves 899x out of both R11 and the booked result', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('3001', 'Försäljning', -400_000),
        row('8999', 'Årets resultat', 400_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateNEDeclaration(makeSupabase() as any, COMPANY_ID, PERIOD_ID)

    expect(result.rutor.R11).toBe(400_000)
    expect(result.bookedResult).toBe(400_000)
    expect(result.sruBlockers).toEqual([])
  })
})

describe('generateNEDeclaration: balansräkning (B1-B16)', () => {
  it('reads B1-B16 off the same books, B10 as tillgångar - skulder', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        row('1220', 'Inventarier', 30_000),
        row('1930', 'Företagskonto', 120_000),
        row('2010', 'Eget kapital', -90_000),
        row('2440', 'Leverantörsskulder', -10_000),
        row('2611', 'Utgående moms', -20_000),
        row('3001', 'Försäljning', -200_000),
        row('5010', 'Lokalhyra', 170_000),
      ],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })

    const result = await generateNEDeclaration(makeSupabase() as never, COMPANY_ID, PERIOD_ID)

    expect(result.balans).toMatchObject({ B4: 30_000, B9: 120_000, B15: 10_000, B16: 20_000, B10: 120_000 })
    expect(result.rutor.R11).toBe(30_000)
    expect(result.warnings.join(' ')).not.toMatch(/balansräkning/)
    const sru = generateNESRUSubmission(result).blanketterSru
    expect(sru).toContain('#UPPGIFT 7300 120000')
    expect(sru).toContain('#UPPGIFT 7600 30000')
  })

  it('warns by name about a balance account the table leaves out', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [row('1930', 'Företagskonto', 10_000), row('2510', 'Skatteskulder', -2_000), row('2010', 'Eget kapital', -8_000)],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })

    const result = await generateNEDeclaration(makeSupabase() as never, COMPANY_ID, PERIOD_ID)

    expect(result.warnings).toContainEqual(expect.stringContaining('Konto 2510 Skatteskulder'))
    expect(result.sruBlockers).toEqual([])
  })
})
