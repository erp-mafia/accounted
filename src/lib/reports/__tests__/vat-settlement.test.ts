import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateVatDeclaration } from '../vat-declaration'
import { buildFiledAmounts } from '../vat-manual-filing'
import {
  buildVatSettlementProposal,
  findDraftVatSettlement,
  firstBookableSettlementDate,
  findPostedVatSettlement,
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
  /** fiscal_periods rows the entry-date resolution walks (period_end >= the period's end). */
  fiscalPeriods?: Array<{ period_start: string; period_end: string; is_closed: boolean; locked_at: string | null }>
  /** company_settings.bookkeeping_locked_through. */
  lockedThrough?: string | null
  /** chart_of_accounts rows (the company's own momskoder / momsrutor). */
  chart?: Array<Record<string, unknown>>
}

let rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>
let journalFilters: Array<[string, unknown[]]>

function makeClient(data: MockData) {
  rpcCalls = []
  journalFilters = []
  return {
    rpc: vi.fn().mockImplementation(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      // The seeded ledger is the period's own range (the first read); the
      // look-ahead and look-back over other ranges find nothing here (they
      // are tested against a real ledger in vat-settlement-match.test.ts).
      if (rpcCalls[0].params.p_start !== params.p_start || rpcCalls[0].params.p_end !== params.p_end) {
        return { data: { totals: [], settlement_shaped_entries: [], source_type_counts: {} }, error: null }
      }
      return {
        data: {
          totals: data.totals ?? [],
          settlement_shaped_entries: data.shaped ?? [],
          source_type_counts: {},
        },
        error: null,
      }
    }),
    from: vi.fn().mockImplementation((table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: Record<string, any> = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'range', 'limit']) {
        b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
          if (table === 'journal_entries') journalFilters.push([m, args])
          return b
        })
      }
      b.maybeSingle = vi.fn().mockResolvedValue(
        table === 'company_settings'
          ? { data: { bookkeeping_locked_through: data.lockedThrough ?? null }, error: null }
          : { data: data.fiscalPeriod ?? null, error: null },
      )
      const listResult = () => {
        if (table === 'chart_of_accounts') return { data: data.chart ?? [], error: null }
        if (table === 'journal_entry_lines') return { data: [], error: null }
        if (table === 'fiscal_periods') return { data: data.fiscalPeriods ?? [], error: null }
        return data.existingError
          ? { data: null, error: data.existingError }
          : { data: data.existing ?? [], error: null }
      }
      b.then = (resolve: (v: unknown) => void) => resolve(listResult())
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
    expect(rpcCalls[0].fn).toBe('get_vat_declaration_totals')
    expect(rpcCalls[0].params).toMatchObject({ p_start: '2026-01-01', p_end: '2026-03-31' })
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

describe('buildVatSettlementProposal reads the declaration\'s own rutor (crm#1171)', () => {
  // 2616 is VMB in BAS (ruta 10); this chart routes it to ruta 30, and 2617,
  // which BAS does not know, to ruta 30 as well (a Fortnox-style chart).
  const chart = [
    { account_number: '2616', account_name: 'Utgående moms omvänd', account_class: 2, default_vat_rate: null, default_vat_treatment: null, vat_box: '30' },
    { account_number: '2617', account_name: 'Utgående moms tjänst utanför EU', account_class: 2, default_vat_rate: null, default_vat_treatment: null, vat_box: '30' },
  ]
  const totals = [
    total('2611', 0, 100.6),
    total('2616', 0, 100.6),
    total('2617', 0, 50.3),
    total('2641', 30.9, 0),
  ]

  it('nets the same whole-krona ruta 49 the declaration files, the company\'s momsrutor included', async () => {
    const proposal = await buildVatSettlementProposal(makeClient({ totals, chart }), 'company-1', 'quarterly', 2026, 1)
    const declaration = await calculateVatDeclaration(makeClient({ totals, chart }), 'company-1', 'quarterly', 2026, 1)

    // ruta 10 = 100 (2611), ruta 30 = trunc(100.60 + 50.30) = 150, ruta 48 = 30:
    // 220. Read by BAS number alone, 2616 joined ruta 10 (trunc 201.20 = 201)
    // and 2617 reached no ruta: 171.
    expect(proposal.filed_net).toBe(220)
    expect(proposal.filed_net).toBe(buildFiledAmounts(declaration.rutor).net)
  })

  it('clears a 26xx account BAS does not know when the company routed it to a ruta', async () => {
    const proposal = await buildVatSettlementProposal(makeClient({ totals, chart }), 'company-1', 'quarterly', 2026, 1)

    expect(rpcCalls[0].params.p_accounts).toEqual(expect.arrayContaining(['2616', '2617']))
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100.6, credit_amount: 0 },
      { account_number: '2616', debit_amount: 100.6, credit_amount: 0 },
      { account_number: '2617', debit_amount: 50.3, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 30.9 },
      { account_number: '2650', debit_amount: 0, credit_amount: 220, line_description: 'Moms att betala' },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.6, line_description: 'Öres- och kronutjämning' },
    ])
  })
})

describe('buildVatSettlementProposal entry date (crm#1171)', () => {
  const closedYear = { period_start: '2025-10-01', period_end: '2026-09-30', is_closed: true, locked_at: '2026-10-10T18:58:16Z' }
  const openYear = { period_start: '2026-10-01', period_end: '2027-09-30', is_closed: false, locked_at: null }

  it('keeps the period\'s last day when the books accept it', async () => {
    const proposal = await buildVatSettlementProposal(
      makeClient({ totals: [total('2611', 0, 100)], fiscalPeriods: [openYear] }),
      'company-1', 'quarterly', 2026, 4,
    )
    expect(proposal.entry_date).toBe('2026-12-31')
    expect(proposal.entry_date_reason).toBeNull()
  })

  it('moves to the first open day after a closed year and says why', async () => {
    const proposal = await buildVatSettlementProposal(
      makeClient({
        totals: [total('2611', 0, 100)],
        fiscalPeriod: { period_start: '2025-10-01', period_end: '2026-09-30' },
        fiscalPeriods: [closedYear, openYear],
      }),
      'company-1', 'yearly', 2026, 1, { fiscalPeriodId: 'fp-1' },
    )
    expect(proposal.entry_date).toBe('2026-10-01')
    expect(proposal.entry_date_reason).toBe('period_closed')
    // The existing-settlement lookup reaches the moved date.
    expect(journalFilters).toContainEqual(['lte', ['entry_date', '2026-10-01']])
  })

  it('gates on a settlement booked after the period with this period\'s text, not on another period\'s', async () => {
    const ours = {
      id: 'je-ours', status: 'posted', entry_date: '2026-10-01', source_type: 'vat_settlement',
      voucher_series: 'A', voucher_number: 1, description: 'Momsredovisning Kvartal 3 2026',
    }
    const theirs = { ...ours, id: 'je-theirs', voucher_number: 2, description: 'Momsredovisning Kvartal 2 2026' }
    const proposal = await buildVatSettlementProposal(
      makeClient({ totals: [total('2611', 0, 100)], fiscalPeriods: [closedYear, openYear], existing: [ours, theirs] }),
      'company-1', 'quarterly', 2026, 3,
    )
    expect(proposal.entry_date).toBe('2026-10-01')
    expect(proposal.existing_entries).toEqual([{
      id: 'je-ours', status: 'posted', entry_date: '2026-10-01', source_type: 'vat_settlement',
      voucher_series: 'A', voucher_number: 1,
    }])
  })

  it('throws when the lock state cannot be read', async () => {
    const supabase = makeClient({ totals: [total('2611', 0, 100)] })
    const from = supabase.from.getMockImplementation()
    supabase.from.mockImplementation((table: string) => {
      const b = from(table)
      if (table === 'fiscal_periods') b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } })
      return b
    })
    await expect(
      buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1),
    ).rejects.toThrow('settlement fiscal period lookup failed: boom')
  })
})

describe('firstBookableSettlementDate', () => {
  const fy = (period_start: string, period_end: string, state: 'open' | 'closed' | 'locked') => ({
    period_start,
    period_end,
    is_closed: state === 'closed',
    locked_at: state === 'locked' ? '2026-01-10T00:00:00Z' : null,
  })

  it('is the period end when nothing covers it', () => {
    expect(firstBookableSettlementDate('2026-03-31', null, [])).toEqual({ entry_date: '2026-03-31', entry_date_reason: null })
  })

  it('steps past the company lock date', () => {
    expect(firstBookableSettlementDate('2026-03-31', '2026-06-30', [fy('2026-01-01', '2026-12-31', 'open')]))
      .toEqual({ entry_date: '2026-07-01', entry_date_reason: 'company_lock_date' })
  })

  it('steps past a locked year after the lock date, keeping the first reason', () => {
    expect(firstBookableSettlementDate('2025-12-31', '2025-12-31', [
      fy('2026-01-01', '2026-12-31', 'locked'),
      fy('2027-01-01', '2027-12-31', 'open'),
    ])).toEqual({ entry_date: '2027-01-01', entry_date_reason: 'company_lock_date' })
  })

  it('names a locked (not closed) year', () => {
    expect(firstBookableSettlementDate('2025-12-31', null, [
      fy('2025-01-01', '2025-12-31', 'locked'),
      fy('2026-01-01', '2026-12-31', 'open'),
    ])).toEqual({ entry_date: '2026-01-01', entry_date_reason: 'period_locked' })
  })

  it('returns the day after a closed year even when no next year exists yet', () => {
    expect(firstBookableSettlementDate('2025-12-31', null, [fy('2025-01-01', '2025-12-31', 'closed')]))
      .toEqual({ entry_date: '2026-01-01', entry_date_reason: 'period_closed' })
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
})
