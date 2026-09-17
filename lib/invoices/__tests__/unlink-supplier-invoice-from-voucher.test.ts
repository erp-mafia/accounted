import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { unlinkSupplierInvoiceFromVoucher } from '../supplier-voucher-matching'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const COMPANY = 'company-1'
const USER = 'user-1'
const INVOICE = 'invoice-1'
const PAYMENT = 'payment-1'
const ENTRY = 'entry-1'

const OK_RESULT = {
  ok: true,
  supplier_invoice_id: INVOICE,
  journal_entry_id: ENTRY,
  transaction_id: 'tx-1',
  payment_amount: 859,
  invoice_status: 'approved',
  paid_amount: 0,
  remaining_amount: 3500,
}

/**
 * Purpose-built stub: the shared helpers resolve rpc() and from() from one
 * queue, and what matters here is which table was touched with which filters
 * AFTER the rpc returned.
 */
function createStub(rpcResult: { data: unknown; error: unknown }) {
  const updates: Array<{ table: string; values: unknown; filters: Array<[string, unknown]> }> = []
  let updateError: unknown = null
  // Candidates the (company, invoice, entry) lookup finds when the RPC returned
  // no transaction_id. Default: exactly one, the unambiguous case.
  let candidates: Array<{ id: string }> = [{ id: 'tx-found' }]

  const from = vi.fn((table: string) => ({
    select: () => {
      const chain = {
        eq: () => chain,
        limit: () => Promise.resolve({ data: candidates, error: null }),
      }
      return chain
    },
    update: (values: unknown) => {
      const record = { table, values, filters: [] as Array<[string, unknown]> }
      updates.push(record)
      const chain = {
        eq(column: string, value: unknown) {
          record.filters.push([column, value])
          return chain
        },
        then(resolve: (v: unknown) => void) {
          return resolve({ data: null, error: updateError })
        },
      }
      return chain
    },
    insert: vi.fn(),
  }))

  const rpc = vi.fn().mockResolvedValue(rpcResult)

  return {
    setCandidates(rows: Array<{ id: string }>) { candidates = rows },
    supabase: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
    updates,
    failUpdate(err: unknown) {
      updateError = err
    },
  }
}

describe('unlinkSupplierInvoiceFromVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('addresses the RPC by payment, invoice, company and acting user', async () => {
    const stub = createStub({ data: OK_RESULT, error: null })

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(stub.rpc).toHaveBeenCalledWith('unlink_supplier_invoice_from_voucher', {
      p_payment_id: PAYMENT,
      p_supplier_invoice_id: INVOICE,
      p_company_id: COMPANY,
      // Attribution for the audit row the RPC writes.
      p_user_id: USER,
    })
    expect(outcome).toEqual({
      ok: true,
      result: {
        supplierInvoiceId: INVOICE,
        journalEntryId: ENTRY,
        paymentAmount: 859,
        invoiceStatus: 'approved',
        paidAmount: 0,
        remainingAmount: 3500,
      },
    })
  })

  it('clears the bank row\'s invoice pointer and nothing else', async () => {
    // releaseLinkedTransactions is deliberately not reused: it also clears
    // journal_entry_id, which is right after a storno and wrong here. The entry
    // stays posted and the bank line genuinely paid it; only the claim that it
    // settled THIS payable was false.
    const stub = createStub({ data: OK_RESULT, error: null })

    await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(stub.updates).toHaveLength(1)
    const [update] = stub.updates
    expect(update.table).toBe('transactions')
    expect(update.values).toEqual({ supplier_invoice_id: null })
    // Addressed to ONE row, because transactions.journal_entry_id is not
    // unique: the old (company, invoice, entry) filter could clear several bank
    // rows when one payable was settled by a split payment on the same
    // verifikat. The id comes from the lookup, not from the RPC's
    // transaction_id, which is always NULL on a row this path can delete.
    //
    // The invoice and entry are re-asserted on the write as a compare-and-set:
    // a row retagged between the lookup and the update must become a no-op
    // rather than have a still-true pointer cleared.
    expect(update.filters).toEqual([
      ['company_id', COMPANY],
      ['id', 'tx-found'],
      ['supplier_invoice_id', INVOICE],
      ['journal_entry_id', ENTRY],
    ])
  })

  it('ignores the RPC transaction_id, which is NULL on every row it can delete', async () => {
    // The link path inserts the payment row with transaction_id NULL; the paths
    // that do set it are refused by the booked-payment guards. Even when a value
    // is present the pointer is resolved by lookup, so the write is addressed to
    // the row that actually carries the claim.
    const stub = createStub({ data: { ...OK_RESULT, transaction_id: 'tx-stale' }, error: null })

    await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(stub.updates).toHaveLength(1)
    expect(stub.updates[0].filters).toContainEqual(['id', 'tx-found'])
    expect(stub.updates[0].filters).not.toContainEqual(['id', 'tx-stale'])
  })

  it('leaves the pointer alone when several bank rows match', async () => {
    const stub = createStub({ data: OK_RESULT, error: null })
    stub.setCandidates([{ id: 'tx-a' }, { id: 'tx-b' }])

    await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    // Ambiguous: one of them may still have its own payment row, and clearing
    // both would unpick a settlement this call did not remove.
    expect(stub.updates).toHaveLength(0)
  })

  it('never writes audit_log itself: RLS has no INSERT policy there', async () => {
    // The audit row is the RPC's, inside the same transaction as the delete.
    // An insert from this client is refused with 42501 every time, so a row
    // written here would be a silent no-op standing in for a legal record.
    const stub = createStub({ data: OK_RESULT, error: null })

    await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(stub.from).not.toHaveBeenCalledWith('audit_log')
  })

  it('leaves the pointer alone when no bank row carries the claim', async () => {
    const stub = createStub({ data: OK_RESULT, error: null })
    stub.setCandidates([])

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(outcome.ok).toBe(true)
    expect(stub.updates).toHaveLength(0)
  })

  it('still succeeds when clearing the bank pointer fails', async () => {
    // The RPC has already committed; the pointer is a hint on the bank row.
    const stub = createStub({ data: OK_RESULT, error: null })
    stub.failUpdate({ message: 'permission denied' })

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(outcome.ok).toBe(true)
  })

  it('passes a refusal through with its code and details', async () => {
    const stub = createStub({
      data: {
        ok: false,
        code: 'UNLINK_SI_PAYMENT_BOOKED_PAYMENT',
        details: { reason: 'invoice_payment_entry_pointer' },
      },
      error: null,
    })

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'UNLINK_SI_PAYMENT_BOOKED_PAYMENT',
      details: { reason: 'invoice_payment_entry_pointer' },
    })
    // A refusal touches nothing afterwards.
    expect(stub.updates).toHaveLength(0)
  })

  it('reports a transport error as a database error', async () => {
    const stub = createStub({ data: null, error: { message: 'connection reset' } })

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'UNLINK_SI_PAYMENT_DB_ERROR',
      details: { reason: 'connection reset' },
    })
  })

  it('reports an empty RPC response as a database error', async () => {
    const stub = createStub({ data: null, error: null })

    const outcome = await unlinkSupplierInvoiceFromVoucher(stub.supabase, USER, COMPANY, {
      supplierInvoiceId: INVOICE,
      paymentId: PAYMENT,
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'UNLINK_SI_PAYMENT_DB_ERROR',
      details: { reason: 'empty RPC response' },
    })
  })
})
