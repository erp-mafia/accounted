/**
 * reconcileStatements: the comparison a customer used to do for us.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  loadTaxAdjustmentSnapshot: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { reconcileStatements } from '../statement-reconciliation'
import { CLOSED_ROWS, EXPECTED, rowsForMode } from './closed-year-fixture'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'

function makeSupabase(isClosed = true) {
  const period = {
    id: PERIOD_ID,
    name: 'Räkenskapsår 2025',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    is_closed: isClosed,
    closing_entry_id: isClosed ? 'closing-1' : null,
    previous_period_id: null,
  }
  function chain(result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'or', 'order', 'limit', 'contains']) {
      c[m] = () => c
    }
    c.single = async () => result
    c.maybeSingle = async () => result
    c.range = async () => result
    return c
  }
  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') return chain({ data: period, error: null })
      if (table === 'company_settings') {
        return chain({
          data: {
            company_name: 'Testbolaget',
            org_number: '5560000000',
            entity_type: 'aktiebolag',
            address_line1: 'Testgatan 1',
            postal_code: '11122',
            city: 'Stockholm',
            email: 'test@example.com',
          },
          error: null,
        })
      }
      if (table === 'companies') return chain({ data: { entity_type: 'aktiebolag' }, error: null })
      if (table === 'journal_entries') {
        return chain({ data: isClosed ? { status: 'posted' } : null, error: null })
      }
      return chain({ data: [], error: null })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { nonDeductibleExpenses: 0, nonTaxableIncome: 0 } as any,
  )
  vi.mocked(generateTrialBalance).mockImplementation(async (_s, _c, _p, opts) => ({
    rows: rowsForMode(opts.closingEntry),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }))
})

describe('reconcileStatements', () => {
  it('reports the ledger, statutory and operational figures side by side', async () => {
    const result = await reconcileStatements(makeSupabase(), COMPANY_ID, PERIOD_ID)

    const byFamily = Object.fromEntries(result.figures.map((f) => [f.family, f]))
    expect(byFamily.ledger.aretsResultat).toBe(EXPECTED.netResult)
    expect(byFamily.statutory.aretsResultat).toBe(EXPECTED.netResult)
    expect(byFamily.statutory.surface).toBe('INK2R (3.26/3.27)')
    // Operational reports before dispositions and tax, and says so.
    expect(byFamily.operational.aretsResultat).toBe(EXPECTED.resultAfterFinancial)
    expect(byFamily.operational.note).toContain('före bokslutsdispositioner')
  })

  it('reconciles when the declaration matches the books', async () => {
    const result = await reconcileStatements(makeSupabase(), COMPANY_ID, PERIOD_ID)

    expect(result.disagreements).toEqual([])
    expect(result.isReconciled).toBe(true)
  })

  it('flags the declaration disagreeing with the booked result', async () => {
    // The reported shape: the form reads 0 while 2099 carries the real result.
    vi.mocked(generateTrialBalance).mockImplementation(async (_s, _c, _p, opts) => ({
      rows: opts.closingEntry === 'include' ? CLOSED_ROWS : CLOSED_ROWS,
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    }))

    const result = await reconcileStatements(makeSupabase(), COMPANY_ID, PERIOD_ID)

    expect(result.isReconciled).toBe(false)
    expect(result.disagreements[0]).toContain('stämmer inte med det fastställda bokslutet')
    expect(result.disagreements[0]).toContain('442000')
  })

  it('does not flag an open year, where 2099 is legitimately empty', async () => {
    const result = await reconcileStatements(makeSupabase(false), COMPANY_ID, PERIOD_ID)

    expect(result.isReconciled).toBe(true)
    const ledger = result.figures.find((f) => f.family === 'ledger')
    expect(ledger?.note).toContain('inte stängt')
  })
})

describe('reconcileStatements: a failing generator must not read as reconciled', () => {
  it('surfaces a declaration that could not be generated', async () => {
    // Regression: the old implementation called the generator and caught ANY
    // throw as "wrong entity type", mapping it to a null figure that the
    // comparison then skipped. A real generator bug therefore reported
    // isReconciled: true, the exact opposite of this function's purpose.
    vi.mocked(generateTrialBalance).mockImplementation(async (_s, _c, _p, opts) => {
      if (opts.closingEntry === 'exclude-final') {
        throw new Error(
          'Closed fiscal period is missing closing_entry_id; statutory pre-closing balances cannot be generated safely',
        )
      }
      return { rows: rowsForMode(opts.closingEntry), totalDebit: 0, totalCredit: 0, isBalanced: true }
    })

    const result = await reconcileStatements(makeSupabase(), COMPANY_ID, PERIOD_ID)

    expect(result.isReconciled).toBe(false)
    expect(result.disagreements.some((d) => d.includes('kunde inte genereras'))).toBe(true)
    const statutory = result.figures.find((f) => f.family === 'statutory')
    expect(statutory?.aretsResultat).toBeNull()
    expect(statutory?.note).toContain('closing_entry_id')
  })

  it('reports no statutory figure for an unsupported entity form, without inventing a disagreement', async () => {
    const supabase = {
      from: (table: string) => {
        const chain = (result: unknown): Record<string, unknown> => {
          const c: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'or', 'order', 'limit', 'contains']) {
            c[m] = () => c
          }
          c.single = async () => result
          c.maybeSingle = async () => result
          c.range = async () => result
          return c
        }
        if (table === 'company_settings') return chain({ data: { entity_type: 'handelsbolag' }, error: null })
        if (table === 'companies') return chain({ data: { entity_type: 'handelsbolag' }, error: null })
        return makeSupabase().from(table)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const result = await reconcileStatements(supabase, COMPANY_ID, PERIOD_ID)

    const statutory = result.figures.find((f) => f.family === 'statutory')
    expect(statutory?.aretsResultat).toBeNull()
    expect(statutory?.note).toContain('stöds')
    expect(result.isReconciled).toBe(true)
  })
})

describe('reconcileStatements: entity-type resolution must not fail silently', () => {
  it('throws when the companies lookup genuinely fails', async () => {
    // Regression: resolveEntityType ignored both queries' error, so a DB
    // failure returned null, landed in the unsupported-form branch and
    // reported isReconciled: true. That is the same silent-false-reconciled
    // bug the surrounding refactor exists to close, one level down.
    const chain = (result: unknown): Record<string, unknown> => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'or', 'order', 'limit', 'contains']) {
        c[m] = () => c
      }
      c.single = async () => result
      c.maybeSingle = async () => result
      c.range = async () => result
      return c
    }
    const supabase = {
      from: (table: string) => {
        if (table === 'company_settings') return chain({ data: null, error: { message: 'no rows' } })
        if (table === 'companies') return chain({ data: null, error: { message: 'permission denied' } })
        return makeSupabase().from(table)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    await expect(reconcileStatements(supabase, COMPANY_ID, PERIOD_ID)).rejects.toThrow(
      /Failed to resolve entity type: permission denied/,
    )
  })

  it('still tolerates a missing company_settings row', async () => {
    // .single() errors on zero rows and many companies have no settings row,
    // so that specific failure must fall through to companies, not throw.
    const chain = (result: unknown): Record<string, unknown> => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'or', 'order', 'limit', 'contains']) {
        c[m] = () => c
      }
      c.single = async () => result
      c.maybeSingle = async () => result
      c.range = async () => result
      return c
    }
    const base = makeSupabase()
    const supabase = {
      from: (table: string) => {
        if (table === 'company_settings') return chain({ data: null, error: { message: 'no rows' } })
        return base.from(table)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const result = await reconcileStatements(supabase, COMPANY_ID, PERIOD_ID)
    const statutory = result.figures.find((f) => f.family === 'statutory')
    expect(statutory?.surface).toBe('INK2R (3.26/3.27)')
  })
})
