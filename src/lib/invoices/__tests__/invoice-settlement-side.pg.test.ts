/**
 * Parity: the TypeScript twin of the settlement-side rule
 * (invoiceSettlementSideFor, lib/invoices/invoice-settlement-side.ts) against
 * the SQL function the link_invoice_to_voucher RPC reads
 * (invoice_settlement_side, 20261018131110), over every combination that
 * decides the side: kontantmetoden, faktureringsmetoden or no settings row,
 * and an invoice with or without a booking verifikat (a kontantmetod carry
 * over the year end, #3440, is the "cash and linked" case).
 *
 * The matcher asks the SQL function first and uses the twin only when it
 * cannot be read; this file is what makes that fallback safe.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  carryCustomerInvoice,
  insertCustomerInvoice,
  seedCashCompany,
} from '@/tests/pg/kontantmetod-carry-fixtures'
import { seedCompany } from '@/tests/pg/fixtures'
import {
  invoiceSettlementSideFor,
  type InvoiceSettlementSide,
} from '@/lib/invoices/invoice-settlement-side'

async function sqlSide(invoiceId: string, companyId: string): Promise<InvoiceSettlementSide | null> {
  const { rows } = await getPool().query<{
    settlement_side: string
    account_prefix: string
    entry_side: 'debit' | 'credit'
  }>(
    'SELECT settlement_side, account_prefix, entry_side FROM public.invoice_settlement_side($1, $2)',
    [invoiceId, companyId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    side: row.settlement_side as InvoiceSettlementSide['side'],
    accountPrefix: row.account_prefix,
    entrySide: row.entry_side,
  }
}

describe('invoice_settlement_side parity with invoiceSettlementSideFor', () => {
  it.each(['cash', 'accrual'] as const)('%s company, unbooked and booked invoice', async (method) => {
    const company = await seedCashCompany(method)

    const unbooked = await insertCustomerInvoice(company)
    expect(await sqlSide(unbooked, company.companyId))
      .toEqual(invoiceSettlementSideFor(method, null))

    // Linked through invoices.journal_entry_id by a real carry (marker +
    // link), the way the cut-off writes it.
    const carried = await insertCustomerInvoice(company)
    const carryId = await carryCustomerInvoice(company, carried)
    expect(await sqlSide(carried, company.companyId))
      .toEqual(invoiceSettlementSideFor(method, carryId))
  })

  it('treats a company without a settings row as faktureringsmetoden', async () => {
    const seeded = await seedCompany()
    const company = { ...seeded, nextPeriodId: seeded.fiscalPeriodId }
    const invoiceId = await insertCustomerInvoice(company)
    expect(await sqlSide(invoiceId, seeded.companyId))
      .toEqual(invoiceSettlementSideFor(null, null))
  })

  it('answers nothing for another company\'s invoice', async () => {
    const owner = await seedCashCompany('cash')
    const other = await seedCashCompany('cash')
    const invoiceId = await insertCustomerInvoice(owner)
    expect(await sqlSide(invoiceId, other.companyId)).toBeNull()
  })
})
