import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { roundOre } from '@/lib/money'

/**
 * The kundreskontra ties out to 1510 when invoices' issue verifikat book
 * their öresavrundning (crm#2283). The 1510 side is summed here from the
 * same voucher lines, independently of the reskontra: the two numbers must
 * agree to the öre with old (exact) and new (rounded) issues open side by
 * side, a part payment, and a kreditfaktura that mirrors its original.
 */

let tables: ReskontraTables
const { supabase } = createReskontraClient(() => tables)

vi.mock('../trial-balance', () => ({
  closingBalanceOf: vi.fn(),
}))

import { closingBalanceOf } from '../trial-balance'
import { generateARReconciliation } from '../ar-reconciliation'
import { generateARLedger } from '../ar-ledger'

type Line = { journal_entry_id: string; account_number: string; debit_amount: number; credit_amount: number }

const customer = { customer_id: 'cust-a', customer: { id: 'cust-a', name: 'Kund AB' } }
const open = { ...customer, invoice_date: '2026-11-13', due_date: '2026-12-13', currency: 'SEK', status: 'sent', paid_amount: 0 }

/** An issue verifikat of 799,80 + 199,95 moms, 1510 at `receivable`, the öre on 3740. */
function issue(id: string, receivable: number): Line[] {
  const ore = roundOre(receivable - 999.75)
  return [
    { journal_entry_id: id, account_number: '1510', debit_amount: receivable, credit_amount: 0 },
    { journal_entry_id: id, account_number: '3001', debit_amount: 0, credit_amount: 799.8 },
    { journal_entry_id: id, account_number: '2611', debit_amount: 0, credit_amount: 199.95 },
    ...(ore !== 0 ? [{ journal_entry_id: id, account_number: '3740', debit_amount: ore < 0 ? -ore : 0, credit_amount: ore > 0 ? ore : 0 }] : []),
  ]
}

/** The 1510 balance, summed from the voucher lines (the ledger side). */
function balance1510(lines: Line[]): number {
  return roundOre(lines.filter((l) => l.account_number === '1510').reduce((s, l) => s + l.debit_amount - l.credit_amount, 0))
}

function setBooks(invoices: Record<string, unknown>[], lines: Line[]) {
  const entryIds = [...new Set(lines.map((l) => l.journal_entry_id))]
  tables = {
    invoices,
    journal_entries: entryIds.map((id) => ({ id, status: 'posted', entry_date: '2026-11-13' })),
    journal_entry_lines: lines,
  }
  vi.mocked(closingBalanceOf).mockResolvedValue(balance1510(lines))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kundreskontran against 1510 with the öresavrundning booked at issue (crm#2283)', () => {
  it('an open invoice issued at 1 000 for 999,75 reads 1 000 and ties out', async () => {
    const lines = issue('je-a', 1000)
    setBooks([{ ...open, id: 'inv-a', invoice_number: 'F1', total: 999.75, journal_entry_id: 'je-a' }], lines)

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    expect(result.account_1510_balance).toBe(1000)
    expect(result.ar_ledger_total).toBe(1000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('old and new issues side by side, a part payment and a mirrored credit all tie out', async () => {
    const lines: Line[] = [
      // Issued before the change: 1510 at the exact total.
      ...issue('je-old', 999.75),
      // Issued with the öre booked, then 500 paid (the payment clears its own kronor).
      ...issue('je-part', 1000),
      { journal_entry_id: 'je-part-pay', account_number: '1930', debit_amount: 500, credit_amount: 0 },
      { journal_entry_id: 'je-part-pay', account_number: '1510', debit_amount: 0, credit_amount: 500 },
      // Issued with the öre booked, then fully credited by a mirrored kreditfaktura.
      ...issue('je-cred', 1000),
      { journal_entry_id: 'je-kr', account_number: '1510', debit_amount: 0, credit_amount: 1000 },
      { journal_entry_id: 'je-kr', account_number: '3001', debit_amount: 799.8, credit_amount: 0 },
      { journal_entry_id: 'je-kr', account_number: '2611', debit_amount: 199.95, credit_amount: 0 },
      { journal_entry_id: 'je-kr', account_number: '3740', debit_amount: 0.25, credit_amount: 0 },
    ]
    setBooks(
      [
        { ...open, id: 'inv-old', invoice_number: 'F1', total: 999.75, journal_entry_id: 'je-old' },
        { ...open, id: 'inv-part', invoice_number: 'F2', total: 999.75, paid_amount: 500, status: 'partially_paid', journal_entry_id: 'je-part' },
        { ...open, id: 'inv-cred', invoice_number: 'F3', total: 999.75, status: 'credited', journal_entry_id: 'je-cred' },
        { ...open, id: 'inv-kr', invoice_number: 'KR-F3', total: -999.75, credited_invoice_id: 'inv-cred', journal_entry_id: 'je-kr' },
      ],
      lines,
    )

    const result = await generateARReconciliation(supabase, 'company-1', 'period-1')

    // 999,75 (old) + 500 (the rest of the 1 000 claim) + 0 (credited away).
    expect(result.account_1510_balance).toBe(1499.75)
    expect(result.ar_ledger_total).toBe(1499.75)
    expect(result.difference).toBe(0)
  })

  it('a paid invoice whose issue booked the öre is not in the reskontra', async () => {
    const lines: Line[] = [
      ...issue('je-paid', 1000),
      { journal_entry_id: 'je-pay', account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { journal_entry_id: 'je-pay', account_number: '1510', debit_amount: 0, credit_amount: 1000 },
    ]
    setBooks([{ ...open, id: 'inv-paid', invoice_number: 'F9', total: 999.75, paid_amount: 999.75, status: 'paid', journal_entry_id: 'je-paid' }], lines)

    const report = await generateARLedger(supabase, 'company-1')

    expect(balance1510(lines)).toBe(0)
    expect(report.total_outstanding).toBe(0)
  })
})
