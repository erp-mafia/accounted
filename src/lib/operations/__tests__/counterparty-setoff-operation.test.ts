/**
 * The two kvittning operations: off while COUNTERPARTY_SETOFF_ENABLED is
 * unset, the read named by exactly one reference, the write handed to the
 * service with its input, and the staged approval pinned to what the
 * preview showed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ book: vi.fn(), balance: vi.fn() }))
vi.mock('@/lib/invoices/counterparty-setoff/book', () => ({ bookCounterpartySetoff: h.book }))
vi.mock('@/lib/invoices/counterparty-setoff/open-items', () => ({ loadCounterpartyBalance: h.balance }))

import { invoicesCounterpartyBalanceGet, invoicesSetoffBook } from '../counterparty-setoff'

const ctx = { supabase: {} as never, companyId: 'company-1', userId: 'user-1', log: {} as never }
const PARTY = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('invoices.counterparty-balance.get', () => {
  it('is off while the switch is unset', async () => {
    vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', '')
    expect(await invoicesCounterpartyBalanceGet.run(ctx, { party_id: PARTY }, { dryRun: false })).toEqual({ ok: false, code: 'SETOFF_DISABLED' })
  })

  it('takes exactly one of party_id, customer_id and supplier_id', async () => {
    expect(await invoicesCounterpartyBalanceGet.run(ctx, {}, { dryRun: false })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(await invoicesCounterpartyBalanceGet.run(ctx, { party_id: PARTY, customer_id: PARTY }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(h.balance).not.toHaveBeenCalled()
  })

  it('answers the balance, or SETOFF_PARTY_NOT_FOUND without one', async () => {
    h.balance.mockResolvedValueOnce({ party: { party_id: PARTY } })
    expect(await invoicesCounterpartyBalanceGet.run(ctx, { customer_id: PARTY }, { dryRun: false })).toEqual({
      ok: true,
      data: { party: { party_id: PARTY } },
    })
    expect(h.balance).toHaveBeenCalledWith(ctx.supabase, 'company-1', { customerId: PARTY })
    h.balance.mockResolvedValueOnce(null)
    expect(await invoicesCounterpartyBalanceGet.run(ctx, { supplier_id: PARTY }, { dryRun: false })).toEqual({
      ok: false,
      code: 'SETOFF_PARTY_NOT_FOUND',
    })
  })
})

describe('invoices.setoff.book', () => {
  it('is off while the switch is unset', async () => {
    vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', '')
    expect(await invoicesSetoffBook.run(ctx, { invoice_id: PARTY, supplier_invoice_id: PARTY }, { dryRun: true })).toEqual({
      ok: false,
      code: 'SETOFF_DISABLED',
    })
    expect(h.book).not.toHaveBeenCalled()
  })

  it('hands the input to the service, the pinned party included', async () => {
    h.book.mockResolvedValue({ ok: true, dryRun: true, preview: {} })
    await invoicesSetoffBook.run(
      ctx,
      { invoice_id: 'inv-1', supplier_invoice_id: 'si-1', amount: 1388, setoff_date: '2026-09-30', note: 'Avtal', party_id: PARTY },
      { dryRun: true },
    )
    expect(h.book).toHaveBeenCalledWith(
      ctx,
      { invoiceId: 'inv-1', supplierInvoiceId: 'si-1', amount: 1388, setoffDate: '2026-09-30', note: 'Avtal', expectedPartyId: PARTY },
      { dryRun: true },
    )
  })

  it('stages the amount, date and counterparty the preview showed', () => {
    const stage = invoicesSetoffBook.mcp!.stage!
    const preview = {
      amount: 1388,
      setoff_date: '2026-10-21',
      party_id: PARTY,
      invoice: { number: '2631' },
      supplier_invoice: { number: null, arrival_number: 41 },
    }
    expect(stage.pinParams!({ invoice_id: 'inv-1', supplier_invoice_id: 'si-1' }, preview)).toEqual({
      invoice_id: 'inv-1',
      supplier_invoice_id: 'si-1',
      amount: 1388,
      setoff_date: '2026-10-21',
      party_id: PARTY,
    })
    expect(stage.title({}, preview)).toBe('Kvitta kundfaktura 2631 mot leverantörsfaktura ankomstnr 41')
    expect(stage.extras!({}, preview).periodDate).toBe('2026-10-21')
  })
})
