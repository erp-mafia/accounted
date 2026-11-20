import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { unlinkSupplierInvoiceFromVoucher, unlinkablePaymentIds, type UnlinkablePaymentRow } from '../supplier-voucher-unlink'

const COMPANY = 'company-1'
const USER = 'user-1'

function rpcClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result)
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

/** A client whose journal_entries read answers `rows`, recording the ids asked for. */
function voucherClient(rows: Array<{ id: string; source_type: string | null }>, error: { message: string } | null = null) {
  const inIds = vi.fn()
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: (_column: string, ids: string[]) => {
      inIds(ids)
      return Promise.resolve({ data: error ? null : rows, error })
    },
  }
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, from, inIds }
}

describe('unlinkSupplierInvoiceFromVoucher', () => {
  it('calls the RPC with the company, the user, the invoice and the payment row', async () => {
    const { client, rpc } = rpcClient({
      data: {
        ok: true,
        payment_id: 'pay-1',
        journal_entry_id: 'je-1',
        unlinked_amount: 400,
        invoice_status: 'partially_paid',
        paid_amount: 600,
        remaining_amount: 400,
        document_on_voucher: true,
      },
      error: null,
    })

    const outcome = await unlinkSupplierInvoiceFromVoucher(client, USER, COMPANY, {
      supplierInvoiceId: 'inv-1',
      paymentId: 'pay-1',
    })

    expect(rpc).toHaveBeenCalledWith('unlink_supplier_invoice_from_voucher', {
      p_company_id: COMPANY,
      p_user_id: USER,
      p_supplier_invoice_id: 'inv-1',
      p_payment_id: 'pay-1',
    })
    expect(outcome).toEqual({
      ok: true,
      result: {
        paymentId: 'pay-1',
        journalEntryId: 'je-1',
        unlinkedAmount: 400,
        invoiceStatus: 'partially_paid',
        paidAmount: 600,
        remainingAmount: 400,
        documentOnVoucher: true,
      },
    })
  })

  it('passes a refusal through with its code and details', async () => {
    const { client } = rpcClient({
      data: { ok: false, code: 'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY', details: { invoice_currency: 'EUR' } },
      error: null,
    })
    expect(
      await unlinkSupplierInvoiceFromVoucher(client, USER, COMPANY, { supplierInvoiceId: 'inv-1', paymentId: 'pay-1' }),
    ).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY', details: { invoice_currency: 'EUR' } })
  })

  it('answers a database error and an empty response as UNLINK_SI_VOUCHER_DB_ERROR', async () => {
    const failed = rpcClient({ data: null, error: { message: 'CASH_ACCOUNT_OPERATION_BUSY' } })
    expect(
      await unlinkSupplierInvoiceFromVoucher(failed.client, USER, COMPANY, { supplierInvoiceId: 'inv-1', paymentId: 'pay-1' }),
    ).toEqual({ ok: false, code: 'UNLINK_SI_VOUCHER_DB_ERROR', details: { reason: 'CASH_ACCOUNT_OPERATION_BUSY' } })

    const empty = rpcClient({ data: null, error: null })
    expect(
      await unlinkSupplierInvoiceFromVoucher(empty.client, USER, COMPANY, { supplierInvoiceId: 'inv-1', paymentId: 'pay-1' }),
    ).toMatchObject({ ok: false, code: 'UNLINK_SI_VOUCHER_DB_ERROR' })
  })
})

describe('unlinkablePaymentIds', () => {
  const paid = { status: 'paid', currency: 'SEK', payment_journal_entry_id: null }
  const row = (overrides: Partial<UnlinkablePaymentRow> & { id: string }): UnlinkablePaymentRow => ({
    journal_entry_id: 'je-manual',
    transaction_id: null,
    notes: null,
    currency: 'SEK',
    payment_exchange_rate: null,
    ...overrides,
  })

  it('offers a plain link to a manual or imported verifikat', async () => {
    const { client, inIds } = voucherClient([
      { id: 'je-manual', source_type: 'manual' },
      { id: 'je-import', source_type: 'import' },
    ])
    const ids = await unlinkablePaymentIds(client, COMPANY, paid, [
      row({ id: 'a' }),
      row({ id: 'b', journal_entry_id: 'je-import', notes: 'Betald via bank' }),
    ])
    expect(ids).toEqual(['a', 'b'])
    expect(inIds).toHaveBeenCalledWith(['je-manual', 'je-import'])
  })

  it('leaves out what the RPC refuses on the row alone, without reading any verifikat', async () => {
    const { client, from } = voucherClient([])
    const ids = await unlinkablePaymentIds(client, COMPANY, { ...paid, payment_journal_entry_id: 'je-own' }, [
      row({ id: 'bank', transaction_id: 'tx-1' }),
      row({ id: 'no-voucher', journal_entry_id: null }),
      row({ id: 'own-payment', journal_entry_id: 'je-own' }),
      row({ id: 'evidence', notes: 'settlement-evidence: import' }),
      row({ id: 'fx-row', currency: 'EUR' }),
      row({ id: 'fx-rate', payment_exchange_rate: 11.3 }),
    ])
    expect(ids).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('leaves out payment verifikat, utlägg and kvittning by the verifikat\'s source type', async () => {
    const { client } = voucherClient([
      { id: 'je-paid', source_type: 'supplier_invoice_paid' },
      { id: 'je-cash', source_type: 'supplier_invoice_cash_payment' },
      { id: 'je-claim', source_type: 'expense_claim' },
      { id: 'je-setoff', source_type: 'counterparty_setoff' },
      { id: 'je-manual', source_type: 'manual' },
    ])
    const ids = await unlinkablePaymentIds(client, COMPANY, paid, [
      row({ id: 'paid', journal_entry_id: 'je-paid' }),
      row({ id: 'cash', journal_entry_id: 'je-cash' }),
      row({ id: 'claim', journal_entry_id: 'je-claim' }),
      row({ id: 'setoff', journal_entry_id: 'je-setoff' }),
      row({ id: 'gone', journal_entry_id: 'je-not-returned' }),
      row({ id: 'link' }),
    ])
    expect(ids).toEqual(['link'])
  })

  it('offers nothing on an invoice that is not paid, or is in a foreign currency', async () => {
    const { client, from } = voucherClient([{ id: 'je-manual', source_type: 'manual' }])
    expect(await unlinkablePaymentIds(client, COMPANY, { ...paid, status: 'credited' }, [row({ id: 'a' })])).toEqual([])
    expect(await unlinkablePaymentIds(client, COMPANY, { ...paid, currency: 'EUR' }, [row({ id: 'a' })])).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('offers nothing when the verifikat cannot be read', async () => {
    const { client } = voucherClient([], { message: 'timeout' })
    expect(await unlinkablePaymentIds(client, COMPANY, paid, [row({ id: 'a' })])).toEqual([])
  })
})
