/**
 * The set-off side of a storno: refused before the storno while an invoice of
 * the set-off has been credited or written off since; afterwards
 * reverse_counterparty_setoff is called with the storno, and a failure is
 * logged, never thrown (the storno stands).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }))

import { createTableMockSupabase } from '@/tests/helpers'
import { assertCounterpartySetoffReversible, syncCounterpartySetoffAfterReversal } from '../reversal'
import { SetoffReversalRefusedError } from '../errors'

type Result = { data: unknown; error: null | { message: string } }

function client(results: Record<string, Result>, rpcResult: Result = { data: { ok: true }, error: null }) {
  return createTableMockSupabase({ ...results, 'rpc:reverse_counterparty_setoff': rpcResult }).supabase
}

const SETOFF = { data: { id: 'set-1', status: 'booked', invoice_id: 'inv-1', supplier_invoice_id: 'si-1' }, error: null }

beforeEach(() => vi.clearAllMocks())

describe('assertCounterpartySetoffReversible', () => {
  it('lets a voucher without a live set-off through', async () => {
    await expect(assertCounterpartySetoffReversible(client({}) as never, 'c-1', 'je-1')).resolves.toBeUndefined()
    await expect(
      assertCounterpartySetoffReversible(client({ counterparty_setoffs: { data: { ...SETOFF.data, status: 'reversed' }, error: null } }) as never, 'c-1', 'je-1'),
    ).resolves.toBeUndefined()
  })

  it('lets a set-off of two open or paid invoices through', async () => {
    const supabase = client({
      counterparty_setoffs: SETOFF,
      invoices: { data: { status: 'paid' }, error: null },
      supplier_invoices: { data: { status: 'partially_paid' }, error: null },
    })
    await expect(assertCounterpartySetoffReversible(supabase as never, 'c-1', 'je-1')).resolves.toBeUndefined()
  })

  it.each([
    ['written_off', 'partially_paid'],
    ['credited', 'paid'],
    ['paid', 'credited'],
    ['paid', 'reversed'],
  ])('refuses when the invoice is %s or the supplier invoice is %s', async (invoiceStatus, supplierStatus) => {
    const supabase = client({
      counterparty_setoffs: SETOFF,
      invoices: { data: { status: invoiceStatus }, error: null },
      supplier_invoices: { data: { status: supplierStatus }, error: null },
    })
    await expect(assertCounterpartySetoffReversible(supabase as never, 'c-1', 'je-1')).rejects.toBeInstanceOf(SetoffReversalRefusedError)
  })

  it('throws on a failed read: unknown is never reversible', async () => {
    await expect(
      assertCounterpartySetoffReversible(client({ counterparty_setoffs: { data: null, error: { message: 'boom' } } }) as never, 'c-1', 'je-1'),
    ).rejects.toThrow(/lookup by voucher failed/)
  })
})

describe('syncCounterpartySetoffAfterReversal', () => {
  it('calls reverse_counterparty_setoff with the set-off, the storno and the actor', async () => {
    const supabase = client({ counterparty_setoffs: SETOFF })
    await syncCounterpartySetoffAfterReversal(supabase as never, 'c-1', 'user-1', 'je-1', { id: 'storno-1' })
    expect(supabase.rpc).toHaveBeenCalledWith('reverse_counterparty_setoff', {
      p_company_id: 'c-1',
      p_setoff_id: 'set-1',
      p_storno_entry_id: 'storno-1',
      p_user_id: 'user-1',
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('does nothing for a voucher without a live set-off', async () => {
    const supabase = client({})
    await syncCounterpartySetoffAfterReversal(supabase as never, 'c-1', 'user-1', 'je-1', { id: 'storno-1' })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('logs a refusal or an error and never throws', async () => {
    const refused = client({ counterparty_setoffs: SETOFF }, { data: { ok: false, code: 'SETOFF_REVERSAL_BLOCKED' }, error: null })
    await expect(syncCounterpartySetoffAfterReversal(refused as never, 'c-1', 'user-1', 'je-1', { id: 'storno-1' })).resolves.toBeUndefined()
    const failed = client({ counterparty_setoffs: SETOFF }, { data: null, error: { message: 'down' } })
    await expect(syncCounterpartySetoffAfterReversal(failed as never, 'c-1', 'user-1', 'je-1', { id: 'storno-1' })).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(2)
  })
})
