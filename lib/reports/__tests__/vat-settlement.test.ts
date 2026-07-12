import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildVatSettlementProposal } from '../vat-settlement'

// ============================================================
// Mock: results routed by table + applied filters (the builder runs its two
// ledger queries and the existing-entries lookup concurrently, so a
// sequential result queue would be order-fragile).
// ============================================================

interface MockData {
  /**
   * journal_entries rows for the entry-scope query (fetchEntryLines step 1).
   * Shape-detection reads status/entry_date/source_type/voucher_* off these.
   */
  entries?: Array<Record<string, unknown>>
  /** journal_entry_lines rows (fetchEntryLines step 2). */
  lines?: Array<Record<string, unknown>>
  /** Existing vat_settlement entries in the period. */
  existing?: Array<Record<string, unknown>>
  /** Error returned by the existing-settlement lookup. */
  existingError?: { message: string }
  /** fiscal_periods row for yearly (helårsmoms) bounds. */
  fiscalPeriod?: { period_start: string; period_end: string } | null
}

let neqCalls: Array<[string, unknown]>

function makeClient(data: MockData) {
  neqCalls = []
  return {
    from: vi.fn().mockImplementation((table: string) => {
      const eqCalls: Array<[string, unknown]> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: Record<string, any> = {}
      for (const m of ['select', 'in', 'gte', 'lte', 'order', 'range', 'limit']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        eqCalls.push([col, val])
        return b
      })
      b.neq = vi.fn().mockImplementation((col: string, val: unknown) => {
        neqCalls.push([col, val])
        return b
      })
      b.maybeSingle = vi.fn().mockResolvedValue({ data: data.fiscalPeriod ?? null, error: null })
      b.then = (resolve: (v: unknown) => void) => {
        if (table === 'journal_entry_lines') return resolve({ data: data.lines ?? [], error: null })
        // journal_entries serves two queries: the entry scope for the ledger
        // totals (filters vat_settlement OUT via .neq) and the tagged
        // existing-settlement lookup (filters it IN via .eq).
        if (eqCalls.some(([col, val]) => col === 'source_type' && val === 'vat_settlement')) {
          return resolve(
            data.existingError
              ? { data: null, error: data.existingError }
              : { data: data.existing ?? [], error: null },
          )
        }
        return resolve({ data: data.entries ?? [], error: null })
      }
      return b
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

let lineId = 0
function vatLine(account: string, debit: number, credit: number, entryId = 'e1') {
  lineId += 1
  return {
    id: `l${lineId}`,
    journal_entry_id: entryId,
    account_number: account,
    debit_amount: debit,
    credit_amount: credit,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  lineId = 0
})

describe('buildVatSettlementProposal', () => {
  it('clears the 26xx accounts, books the filed whole-krona net on 2650 and the öre gap on 3740', async () => {
    const supabase = makeClient({
      entries: [{ id: 'e1' }],
      lines: [
        vatLine('2611', 0, 2500.75),
        vatLine('2641', 1000.5, 0),
        // Revenue feeds ruta05 but is never part of the settlement entry.
        vatLine('3001', 0, 10003.0),
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
    // would change the next proposal.
    expect(neqCalls).toContainEqual(['source_type', 'vat_settlement'])
  })

  it('books a refund period as a 1650 (Momsfordran) debit', async () => {
    const supabase = makeClient({
      entries: [{ id: 'e1' }],
      lines: [
        vatLine('2611', 0, 100),
        vatLine('2641', 400, 0),
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
      entries: [{ id: 'e1' }],
      // Output VAT with a net DEBIT balance: credit notes exceeded sales.
      lines: [vatLine('2611', 50, 0)],
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
      entries: [{ id: 'e1' }],
      lines: [vatLine('3001', 0, 1000)],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 2)

    expect(proposal.is_empty).toBe(true)
    expect(proposal.lines).toEqual([])
    expect(proposal.filed_net).toBe(0)
  })

  it('uses the räkenskapsår bounds for yearly VAT when a fiscal period is supplied', async () => {
    const supabase = makeClient({
      entries: [{ id: 'e1' }],
      lines: [vatLine('2611', 0, 100), vatLine('2641', 25, 0)],
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
      entries: [{ id: 'e1' }],
      lines: [vatLine('2611', 0, 100)],
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
      entries: [{ id: 'e1' }, manualSettlement],
      lines: [
        // Business activity on e1.
        vatLine('2611', 0, 100),
        vatLine('2641', 25, 0),
        // Manual momsomföring on e2: clears 26xx to 2650 without the
        // vat_settlement source_type (booked before #980 shipped).
        vatLine('2611', 100, 0, 'e2'),
        vatLine('2641', 0, 25, 'e2'),
        vatLine('2650', 0, 75, 'e2'),
      ],
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
      entries: [
        { id: 'e1' },
        // A manual settlement that has been annulled...
        {
          id: 'e2', status: 'reversed', entry_date: '2026-03-31',
          source_type: 'manual', voucher_series: 'A', voucher_number: 9,
        },
        // ...and its storno reversal.
        {
          id: 'e3', status: 'posted', entry_date: '2026-03-31',
          source_type: 'storno', voucher_series: 'A', voucher_number: 10,
        },
      ],
      lines: [
        vatLine('2611', 0, 100),
        vatLine('2611', 100, 0, 'e2'),
        vatLine('2650', 0, 100, 'e2'),
        vatLine('2611', 0, 100, 'e3'),
        vatLine('2650', 100, 0, 'e3'),
      ],
    })

    const proposal = await buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1)

    // Settlement + storno are both excluded from the projection (they would
    // otherwise double ruta 10), and neither gates: the period can be
    // settled again.
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
      entries: [
        { id: 'e1' },
        {
          id: 'e2', status: 'posted', entry_date: '2026-02-12',
          source_type: 'bank_transaction', voucher_series: 'A', voucher_number: 7,
        },
      ],
      lines: [
        vatLine('2611', 0, 100),
        // Paying last period's VAT debt: 2650 against the bank account.
        // Touches a settlement net account but no declaration account, so it
        // is NOT settlement-shaped: it must neither gate nor shift the rutor.
        vatLine('2650', 75, 0, 'e2'),
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

  it('throws when the existing-settlement lookup fails (the UI gate depends on it)', async () => {
    const supabase = makeClient({
      entries: [{ id: 'e1' }],
      lines: [vatLine('2611', 0, 100)],
      existingError: { message: 'boom' },
    })

    await expect(
      buildVatSettlementProposal(supabase, 'company-1', 'quarterly', 2026, 1),
    ).rejects.toThrow('existing vat_settlement lookup failed: boom')
  })
})
