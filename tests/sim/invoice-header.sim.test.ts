/**
 * An invoice booked from its header, the path a door takes when no items are
 * loaded. The company's own invoices, stored by the doors that issued them, go
 * through it here. Every entry must balance and book the VAT the invoice's
 * posted verifikat booked, on the same account. An invoice with VAT on several
 * accounts cannot: one treatment has one account, so its header stays refused.
 */
import { describe, expect, it } from 'vitest'
import { validateBalance } from '@/lib/bookkeeping/engine'
import {
  buildCreditNoteLines,
  buildInvoiceCashLines,
  buildInvoiceRegistrationLines,
} from '@/lib/bookkeeping/invoice-lines'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Invoice } from '@/types'
import { loadSimCompany } from './company'

const { state, supabase } = loadSimCompany()

const invoices = () =>
  fetchAllRows<Invoice>(({ from, to }) =>
    supabase.from('invoices').select('*').eq('company_id', state.companyId).order('id').range(from, to),
  )

describe('the company\'s invoices, booked from their headers', () => {
  it('balance at the registration, the kontantmetod payment and the credit note, or stay refused', async () => {
    const rows = (await invoices()).filter((row) => row.total > 0)
    expect(rows.length).toBeGreaterThan(0)

    const wrong = rows.flatMap((row) => {
      const invoice = { ...row, items: [] }
      const note = { ...invoice, subtotal: -row.subtotal, vat_amount: -row.vat_amount, total: -row.total }
      const registration = validateBalance(buildInvoiceRegistrationLines(invoice, 'aktiebolag')).valid
      const payment = validateBalance(buildInvoiceCashLines(invoice, 'aktiebolag').lines).valid
      const credit = validateBalance(buildCreditNoteLines(note, 'aktiebolag')).valid
      // Registration and payment share one answer; a credit note reverses what exists.
      return registration === payment && credit ? [] : [[row.invoice_number, registration, payment, credit]]
    })

    expect(wrong).toEqual([])
  })

  it('book the VAT the posted verifikat booked, on its account, or stay refused when it took several', async () => {
    const rows = (await invoices()).filter((row) => row.journal_entry_id && row.vat_amount > 0)
    expect(rows.length).toBeGreaterThan(0)

    const posted = new Map<string, Map<string, number>>()
    for (let start = 0; start < rows.length; start += 100) {
      const { data, error } = await supabase
        .from('journal_entry_lines')
        .select('journal_entry_id, account_number, credit_amount')
        .in('journal_entry_id', rows.slice(start, start + 100).map((row) => row.journal_entry_id as string))
        .like('account_number', '26%')
      if (error) throw error
      for (const line of data as Array<{ journal_entry_id: string; account_number: string; credit_amount: number }>) {
        const accounts = posted.get(line.journal_entry_id) ?? new Map<string, number>()
        accounts.set(line.account_number, (accounts.get(line.account_number) ?? 0) + Number(line.credit_amount))
        posted.set(line.journal_entry_id, accounts)
      }
    }

    const differing = rows.flatMap((row) => {
      const accounts = posted.get(row.journal_entry_id as string) ?? new Map<string, number>()
      const lines = buildInvoiceRegistrationLines({ ...row, items: [] }, 'aktiebolag')
      if (!validateBalance(lines).valid) return accounts.size > 1 ? [] : [[row.invoice_number, 'refused']]
      const vatLines = lines.filter((line) => line.account_number.startsWith('26'))
      const same = vatLines.length === accounts.size && vatLines.every(
        (line) => Math.abs(line.credit_amount - (accounts.get(line.account_number) ?? 0)) < 0.005,
      )
      return same ? [] : [[row.invoice_number, vatLines, [...accounts]]]
    })

    expect(differing).toEqual([])
  })
})
