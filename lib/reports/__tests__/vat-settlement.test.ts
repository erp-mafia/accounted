import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildVatSettlementProposal } from '../vat-settlement'

// ============================================================
// Mock: results routed by table + select shape (the builder runs its two
// ledger queries and the existing-entries lookup concurrently, so a
// sequential result queue would be order-fragile).
// ============================================================

interface MockData {
  /** journal_entries rows for the entry-scope query (fetchEntryLines step 1). */
  entries?: Array<{ id: string }>
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
      let selectStr = ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: Record<string, any> = {}
      b.select = vi.fn().mockImplementation((s: string) => {
        selectStr = s
        return b
      })
      for (const m of ['eq', 'in', 'gte', 'lte', 'order', 'range', 'limit']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.neq = vi.fn().mockImplementation((col: string, val: unknown) => {
        neqCalls.push([col, val])
        return b
      })
      b.maybeSingle = vi.fn().mockResolvedValue({ data: data.fiscalPeriod ?? null, error: null })
      b.then = (resolve: (v: unknown) => void) => {
        if (table === 'journal_entry_lines') return resolve({ data: data.lines ?? [], error: null })
        // journal_entries serves two queries: the entry scope for the ledger
        // totals (select 'id') and the existing-settlement lookup (selects
        // voucher columns).
        if (selectStr.includes('voucher_series')) {
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
function vatLine(account: string, debit: number, credit: number) {
  lineId += 1
  return {
    id: `l${lineId}`,
    journal_entry_id: 'e1',
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
