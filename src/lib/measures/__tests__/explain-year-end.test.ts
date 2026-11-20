import { describe, it, expect, vi, beforeEach } from 'vitest'

const { generateGeneralLedger } = vi.hoisted(() => ({ generateGeneralLedger: vi.fn() }))
vi.mock('@/lib/reports/general-ledger', () => ({ generateGeneralLedger }))

import { ledgerForAccounts } from '../explain'

// The income measures' drill-down leaves out what the resultaträkning leaves
// out ('exclude-all-year-end'): the set from year_end_chain_entry_ids, which
// also holds a resultatavslut booked in a previous system or by hand
// (20261024140100), not only source_type 'year_end'.

const line = (journal_entry_id: string, source_type: string, debit: number, credit: number) => ({
  date: '2026-12-31', voucher_series: 'A', voucher_number: 1, journal_entry_id, description: '',
  source_type, debit, credit, balance: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  generateGeneralLedger.mockResolvedValue({
    period: { start: '2026-01-01', end: '2026-12-31' },
    accounts: [{
      account_number: '3001', account_name: 'Försäljning', opening_balance: 0,
      closing_balance: 0, total_debit: 10050, total_credit: 10000,
      lines: [
        line('sale-1', 'manual', 0, 10000),
        line('closing-import-1', 'import', 10000, 0),
        line('ye-1', 'year_end', 50, 0),
      ],
    }],
  })
})

describe('ledgerForAccounts', () => {
  it("drops the 'exclude-all-year-end' set when excludeYearEnd is set", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ['closing-import-1', 'ye-1'], error: null })
    const ledgers = await ledgerForAccounts(
      { supabase: { rpc } as never, companyId: 'company-1' } as never, 'period-1', ['3001'], {}, { excludeYearEnd: true },
    )

    expect(rpc).toHaveBeenCalledWith('year_end_chain_entry_ids', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
    })
    const ledger = ledgers.get('3001')!
    expect(ledger.lines.map((l) => l.journal_entry_id)).toEqual(['sale-1'])
    expect(ledger.closing).toBe(-10000)
  })

  it('keeps every line, and reads no set, without excludeYearEnd', async () => {
    const rpc = vi.fn()
    const ledgers = await ledgerForAccounts(
      { supabase: { rpc } as never, companyId: 'company-1' } as never, 'period-1', ['3001'], {},
    )

    expect(rpc).not.toHaveBeenCalled()
    expect(ledgers.get('3001')!.lines).toHaveLength(3)
  })
})
