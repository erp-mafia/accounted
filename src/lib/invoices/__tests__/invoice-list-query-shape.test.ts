import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../app/(dashboard)/invoices/page.tsx'),
  'utf8',
)

describe('invoice list query shape', () => {
  it('paginates beyond the PostgREST row cap with a stable total order', () => {
    expect(source).toContain('fetchAllRows<ListInvoice>')
    expect(source).toContain(".order('invoice_date', { ascending: false })")
    expect(source).toContain(".order('id', { ascending: false })")
    expect(source).toContain('.range(from, to)')
    expect(source).toContain('dedupeBy: (invoice) => invoice.id')
  })

  // The list holds every invoice of the company in memory, so a row carries
  // the columns the list reads and no more: `*` was 1.7 kB of JSON per
  // invoice against 0.56 kB, 54 MB against 18 MB for the largest register
  // in production (2026-11-12).
  it('selects the columns the list reads, never the whole invoice', () => {
    expect(source).toContain(
      "'id, customer_id, invoice_number, external_invoice_number, is_self_billed, document_type, status, quote_status, invoice_date, due_date, valid_until, subtotal, total, total_sek, currency, ore_rounding, credited_invoice_id, remaining_amount, paid_at, deduction_total, journal_entry_id, customer:customers(name)'",
    )
    expect(source).not.toMatch(/\.from\('invoices'\)\s*\.select\(\s*'\*/)
  })

  // Read from the begäran side and joined onto the rows by invoice id
  // (withDeductionFacts), instead of an embed evaluated for every invoice of
  // the register on every page of the list read.
  it('reads the begäran behind each invoice for the ROT/RUT column and filter (#2426)', () => {
    expect(source).toContain(".from('rot_rut_payout_requests')")
    expect(source).toContain("'id, status, created_at, items:rot_rut_payout_request_items(invoice_id)'")
    expect(source).toContain('withDeductionFacts(firstPage, facts)')
    expect(source).toContain('withDeductionFacts(allRows, facts)')
  })

  it('embeds each deduction line\'s kind, so a grön teknik invoice never reads "Att begära"', () => {
    expect(source).toContain('deduction_lines:invoice_items(deduction_type)')
    expect(source).toContain(".not('deduction_lines.deduction_type', 'is', null)")
  })
})
