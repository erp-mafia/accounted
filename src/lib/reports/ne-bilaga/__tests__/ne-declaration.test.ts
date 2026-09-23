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
      throw new Error(`unexpected table ${table}`)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: PRE_CLOSING_ROWS,
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
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
