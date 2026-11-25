import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { issueOreByInvoice, withIssueOre } from '../reskontra-issue-ore'
import { generateARLedger } from '../ar-ledger'

/**
 * The öre an invoice's issue verifikat booked, in the kundreskontra
 * (crm#2283): counted while the customer's part is open, never after it is
 * settled, and only read for invoices that can carry one.
 */

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  currency: 'SEK',
  total: 999.75,
  deduction_total: null,
  journal_entry_id: 'je-1',
  ...overrides,
})

describe('withIssueOre', () => {
  it('adds the booked öre while the customer owes anything', () => {
    expect(withIssueOre(999.75, 999.75, invoice(), -0.25)).toBe(1000)
    expect(withIssueOre(499.75, 499.75, invoice(), -0.25)).toBe(500)
  })

  it('adds nothing once the customer part is settled', () => {
    expect(withIssueOre(0, 0, invoice(), -0.25)).toBe(0)
  })

  it('a ROT/RUT invoice paid by the customer keeps only Skatteverket’s open share', () => {
    // 837,50 with RUT 418, issued at 420 on 1510: the customer paid 419,50,
    // 418 waits for Skatteverket. The customer part is closed.
    const rut = invoice({ total: 837.5, deduction_total: 418 })
    expect(withIssueOre(418, 418, rut, -0.5)).toBe(418)
    // Unpaid: the customer's 420 and Skatteverket's 418.
    expect(withIssueOre(837.5, 837.5, rut, -0.5)).toBe(838)
  })

  it('a kreditfaktura that mirrored its original reads the rounded credit', () => {
    expect(withIssueOre(-999.75, -999.75, invoice({ total: -999.75 }), 0.25)).toBe(-1000)
  })

  it('an invoice without a booked öre is left as it is', () => {
    expect(withIssueOre(999.75, 999.75, invoice(), undefined)).toBe(999.75)
  })
})

describe('issueOreByInvoice', () => {
  let tables: ReskontraTables
  const { supabase, calls } = createReskontraClient(() => tables)

  beforeEach(() => {
    calls.length = 0
    tables = {
      journal_entries: [{ id: 'je-1', status: 'posted' }, { id: 'je-2', status: 'posted' }],
      journal_entry_lines: [
        { journal_entry_id: 'je-1', account_number: '1510', debit_amount: 1000, credit_amount: 0 },
        { journal_entry_id: 'je-2', account_number: '1510', debit_amount: 999.75, credit_amount: 0 },
      ],
    }
  })

  it('reads only SEK invoices with öre and an issue verifikat, and keeps those that booked one', async () => {
    tables.invoices = [
      invoice(),
      invoice({ id: 'inv-2', journal_entry_id: 'je-2' }),
      invoice({ id: 'inv-whole', total: 1000 }),
      invoice({ id: 'inv-eur', currency: 'EUR' }),
      invoice({ id: 'inv-unbooked', journal_entry_id: null }),
    ]

    const out = await issueOreByInvoice(supabase, 'company-1', tables.invoices as never)

    expect([...out]).toEqual([['inv-1', -0.25]])
    expect(calls).toEqual([
      { name: 'invoice_issue_receivable_sek', args: { p_company_id: 'company-1', p_invoice_ids: ['inv-1', 'inv-2'] } },
    ])
  })

  it('reads nothing when no invoice can carry an öre', async () => {
    tables.invoices = [invoice({ total: 1000 })]
    expect((await issueOreByInvoice(supabase, 'company-1', tables.invoices as never)).size).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('generateARLedger with the öre booked at issue', () => {
  let tables: ReskontraTables
  let failures: Record<string, { message: string }>
  const { supabase } = createReskontraClient(() => tables, () => failures)
  const open = { customer_id: 'cust-a', customer: { id: 'cust-a', name: 'Kund AB' }, invoice_date: '2026-11-13', due_date: '2026-12-13', currency: 'SEK', status: 'sent', paid_amount: 0 }

  beforeEach(() => {
    vi.clearAllMocks()
    failures = {}
    tables = {
      invoices: [{ ...open, id: 'inv-1', invoice_number: 'F1', total: 999.75, journal_entry_id: 'je-1' }],
      journal_entries: [{ id: 'je-1', status: 'posted', entry_date: '2026-11-13' }],
      journal_entry_lines: [{ journal_entry_id: 'je-1', account_number: '1510', debit_amount: 1000, credit_amount: 0 }],
    }
  })

  it('counts it live and as of a date after the issue', async () => {
    expect((await generateARLedger(supabase, 'company-1')).total_outstanding).toBe(1000)
    expect((await generateARLedger(supabase, 'company-1', '2026-11-20')).total_outstanding).toBe(1000)
  })

  it('a failed read leaves the invoice figures; strict throws', async () => {
    failures = { invoice_issue_receivable_sek: { message: 'DB error' } }
    expect((await generateARLedger(supabase, 'company-1')).total_outstanding).toBe(999.75)
    await expect(generateARLedger(supabase, 'company-1', undefined, { strict: true })).rejects.toThrow()
  })
})
