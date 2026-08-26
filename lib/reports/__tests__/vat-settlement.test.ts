import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildVatSettlementProposal,
  findDraftVatSettlement,
  findPostedVatSettlement,
  vatDeadlineTaxPeriod,
  vatSettlementBookingStatus,
  type VatSettlementExistingEntry,
} from '../vat-settlement'

// ============================================================
// Mock: fetchVatAccountTotals now goes through the
// get_vat_declaration_totals RPC (aggregation + settlement-shape detection
// in SQL, verified by tests/pg/vat-declaration-totals-rpc.pg.test.ts), so
// the mock seeds the RPC payload directly: per-account totals as the SQL
// GROUP BY returns them (already excluding settlement entries) plus the
// shaped entries the RPC surfaces. The existing-entries lookup and the
// fiscal-period resolution still go through from().
// ============================================================

interface MockData {
  /** Per-account totals as returned by the RPC (post settlement-exclusion). */
  totals?: Array<{ account_number: string; debit: number; credit: number }>
  /** Settlement-shaped entries surfaced by the RPC. */
  shaped?: Array<Record<string, unknown>>
  /** Existing vat_settlement entries in the period. */
  existing?: Array<Record<string, unknown>>
  /** Error returned by the existing-settlement lookup. */
  existingError?: { message: string }
  /** fiscal_periods row for yearly (helårsmoms) bounds. */
  fiscalPeriod?: { period_start: string; period_end: string } | null
}

let rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>

function makeClient(data: MockData) {
  rpcCalls = []
  return {
    rpc: vi.fn().mockImplementation(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      return {
        data: {
          totals: data.totals ?? [],
          settlement_shaped_entries: data.shaped ?? [],
          source_type_counts: {},
        },
        error: null,
      }
    }),
    from: vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: Record<string, any> = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'range', 'limit']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.maybeSingle = vi.fn().mockResolvedValue({ data: data.fiscalPeriod ?? null, error: null })
      // The only awaited from() query left in the proposal builder is the
      // tagged existing-settlement lookup.
      b.then = (resolve: (v: unknown) => void) =>
        resolve(
          data.existingError
            ? { data: null, error: data.existingError }
            : { data: data.existing ?? [], error: null },
        )
      return b
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function total(account_number: string, debit: number, credit: number) {
  return { account_number, debit, credit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildVatSettlementProposal', () => {
  it('clears the 26xx accounts, books the filed whole-krona net on 2650 and the öre gap on 3740', async () => {
    const supabase = makeClient({
      totals: [
        total('2611', 0, 2500.75),
        total('2641', 1000.5, 0),
        // Revenue feeds ruta05 but is never part of the settlement entry.
        total('3001', 0, 10003.0),
      ],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    expect(proposal.period).toEqual({
      type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31',
    })
    expect(proposal.entry_date).toBe('2026-03-31')
    expect(proposal.description).toBe('Momsredovisning Kvartal 1 2026')
    expect(proposal.is_empty).toBe(false)
    // Filed net = trunc(2500.75) - trunc(1000.50) = 1500 (öretal faller bort)
    expect(proposal.filed_net).toBe(1500)
    expect(proposal.rounding_amount).toBe(0.25)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 2500.75, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1000.5 },
      {
        account_number: '2650', debit_amount: 0, credit_amount: 1500,
        line_description: 'Moms att betala',
      },
      {
        account_number: '3740', debit_amount: 0, credit_amount: 0.25,
        line_description: 'Öres- och kronutjämning',
      },
    ])

    // The proposed entry always balances.
    const debits = proposal.lines.reduce((s, l) => s + l.debit_amount, 0)
    const credits = proposal.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(debits).toBeCloseTo(credits, 2)

    // The projection must ignore already-booked settlements, or booking once
    // would change the next proposal: the RPC receives the settlement net
    // accounts so it can shape-detect and exclude them.
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('get_vat_declaration_totals')
    expect(rpcCalls[0].params.p_net_accounts).toEqual(['2650', '1650'])
    expect(rpcCalls[0].params.p_company_id).toBe('company-1')
  })

  it('books a refund period as a 1650 (Momsfordran) debit', async () => {
    const supabase = makeClient({
      totals: [
        total('2611', 0, 100),
        total('2641', 400, 0),
      ],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'monthly', 2026, 6)

    expect(proposal.filed_net).toBe(-300)
    expect(proposal.rounding_amount).toBe(0)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 400 },
      {
        account_number: '1650', debit_amount: 300, credit_amount: 0,
        line_description: 'Moms att återfå',
      },
    ])
  })

  it('clears an account sitting on the wrong side (credit-note-heavy period)', async () => {
    const supabase = makeClient({
      // Output VAT with a net DEBIT balance: credit notes exceeded sales.
      totals: [total('2611', 50, 0)],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'monthly', 2026, 2)

    expect(proposal.filed_net).toBe(-50)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 0, credit_amount: 50 },
      {
        account_number: '1650', debit_amount: 50, credit_amount: 0,
        line_description: 'Moms att återfå',
      },
    ])
  })

  it('is empty when the period has no VAT-account activity (revenue alone does not settle)', async () => {
    const supabase = makeClient({
      totals: [total('3001', 0, 1000)],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 2)

    expect(proposal.is_empty).toBe(true)
    expect(proposal.lines).toEqual([])
    expect(proposal.filed_net).toBe(0)
  })

  it('uses the räkenskapsår bounds for yearly VAT when a fiscal period is supplied', async () => {
    const supabase = makeClient({
      totals: [total('2611', 0, 100), total('2641', 25, 0)],
      fiscalPeriod: { period_start: '2025-07-01', period_end: '2026-06-30' },
    })

    const proposal = await buildVatSettlementProposal(
      supabase, 'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' },
    )

    expect(proposal.period.start).toBe('2025-07-01')
    expect(proposal.period.end).toBe('2026-06-30')
    expect(proposal.entry_date).toBe('2026-06-30')
    expect(proposal.description).toBe('Momsredovisning Helår 2026')
  })

  it('surfaces existing vat_settlement entries in the period', async () => {
    const existing = [{
      id: 'je-1', status: 'posted', entry_date: '2026-03-31',
      voucher_series: 'M', voucher_number: 3,
    }]
    const supabase = makeClient({
      totals: [total('2611', 0, 100)],
      existing,
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    expect(proposal.existing_entries).toEqual(existing)
  })

  it('gates on a manual settlement-shaped entry and still proposes the full-period clear (#984)', async () => {
    const manualSettlement = {
      id: 'e2', status: 'posted', entry_date: '2026-03-31',
      source_type: 'manual', voucher_series: 'A', voucher_number: 9,
    }
    const supabase = makeClient({
      // The RPC already excluded the manual momsomföring from the totals
      // (that exclusion is pg-tested); what reaches JS is the business
      // activity plus the shaped entry to gate on.
      totals: [
        total('2611', 0, 100),
        total('2641', 25, 0),
      ],
      shaped: [manualSettlement],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    // The manual settlement is excluded from the projection: the proposal
    // shows the same full-period clear the report shows, and the posted
    // shaped entry gates the booking button via existing_entries.
    expect(proposal.is_empty).toBe(false)
    expect(proposal.filed_net).toBe(75)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 25 },
      {
        account_number: '2650', debit_amount: 0, credit_amount: 75,
        line_description: 'Moms att betala',
      },
    ])
    expect(proposal.existing_entries).toEqual([manualSettlement])
  })

  it('does not gate on a storno of a settlement (annullera must re-enable booking)', async () => {
    const supabase = makeClient({
      // Settlement + storno cancel out of the totals inside the RPC; both
      // still come back as shaped entries. Neither may gate: the reversed
      // manual settlement has no balance effect and the storno is the
      // cancellation itself.
      totals: [total('2611', 0, 100)],
      shaped: [
        {
          id: 'e2', status: 'reversed', entry_date: '2026-03-31',
          source_type: 'manual', voucher_series: 'A', voucher_number: 9,
        },
        {
          id: 'e3', status: 'posted', entry_date: '2026-03-31',
          source_type: 'storno', voucher_series: 'A', voucher_number: 10,
        },
      ],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    expect(proposal.existing_entries).toEqual([])
    expect(proposal.filed_net).toBe(100)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      {
        account_number: '2650', debit_amount: 0, credit_amount: 100,
        line_description: 'Moms att betala',
      },
    ])
  })

  it('ignores a plain VAT payment on 2650 (no declaration accounts touched)', async () => {
    const supabase = makeClient({
      // Paying last period's VAT debt: 2650 against the bank account. The
      // entry touches a settlement net account but no declaration account,
      // so the RPC does NOT shape it: its 2650 total comes back as-is and
      // must neither gate nor shift the rutor / clearing lines.
      totals: [
        total('2611', 0, 100),
        total('2650', 75, 0),
      ],
      shaped: [],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    expect(proposal.existing_entries).toEqual([])
    expect(proposal.filed_net).toBe(100)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      {
        account_number: '2650', debit_amount: 0, credit_amount: 100,
        line_description: 'Moms att betala',
      },
    ])
  })

  it('throws when the existing-settlement lookup fails (the UI gate depends on it)', async () => {
    const supabase = makeClient({
      totals: [total('2611', 0, 100)],
      existingError: { message: 'boom' },
    })

    await expect(
      buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1),
    ).rejects.toThrow('existing vat_settlement lookup failed: boom')
  })
})

describe('vat settlement UI gate helpers', () => {
  const posted: VatSettlementExistingEntry = {
    id: 'je-posted',
    status: 'posted',
    entry_date: '2026-06-30',
    source_type: 'vat_settlement',
    voucher_series: 'A',
    voucher_number: 83,
  }
  const draft: VatSettlementExistingEntry = {
    id: 'je-draft',
    status: 'draft',
    entry_date: '2026-06-30',
    source_type: 'vat_settlement',
    voucher_series: 'A',
    voucher_number: 84,
  }

  it('picks the posted settlement over a draft', () => {
    expect(findPostedVatSettlement([draft, posted])).toEqual(posted)
    expect(findDraftVatSettlement([draft, posted])).toBeUndefined()
    expect(vatSettlementBookingStatus([draft, posted])).toBe('booked')
  })

  it('surfaces a draft only when nothing is posted', () => {
    expect(findPostedVatSettlement([draft])).toBeUndefined()
    expect(findDraftVatSettlement([draft])).toEqual(draft)
    expect(vatSettlementBookingStatus([draft])).toBe('draft')
  })

  it('is none when the period has no settlement', () => {
    expect(findPostedVatSettlement([])).toBeUndefined()
    expect(vatSettlementBookingStatus([])).toBe('none')
    expect(vatSettlementBookingStatus(undefined)).toBe('none')
  })

  it('formats the calendar tax_period for monthly and quarterly VAT', () => {
    expect(vatDeadlineTaxPeriod('monthly', 2026, 6)).toBe('2026-06')
    expect(vatDeadlineTaxPeriod('quarterly', 2026, 2)).toBe('2026-Q2')
    expect(vatDeadlineTaxPeriod('yearly', 2026, 1)).toBeNull()
  })
})
