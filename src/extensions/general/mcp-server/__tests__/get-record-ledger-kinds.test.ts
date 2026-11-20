/**
 * gnubok_get_record on the ledger kinds (2026-11-09): a bank row, a customer
 * invoice, a supplier invoice and a skattekonto row, each the existing detail
 * read plus its links (src/lib/links/record-links.ts, tested there). Here the
 * readers are mocked so the tool contract is what is pinned: the core comes
 * from the tool that reads the record alone, the links ride inside it, and a
 * missing record is NOT_FOUND.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/transactions/read-with-vouchers', () => ({ readTransactionWithVouchers: vi.fn() }))
vi.mock('@/lib/links/record-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/links/record-links')>('@/lib/links/record-links')
  return {
    ...actual,
    transactionLinks: vi.fn(),
    invoiceLinks: vi.fn(),
    supplierInvoiceLinks: vi.fn(),
    readSkattekontoRow: vi.fn(),
  }
})

import { tools } from '../server'
import { readTransactionWithVouchers } from '@/lib/transactions/read-with-vouchers'
import { invoiceLinks, readSkattekontoRow, supplierInvoiceLinks, transactionLinks, type RecordLink } from '@/lib/links/record-links'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TX = '11111111-1111-4111-8111-111111111111'
const INV = '33333333-3333-4333-8333-333333333333'
const SI = '22222222-2222-4222-8222-222222222222'
const SKV = '55555555-5555-4555-8555-555555555555'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const tool = (name: string) => tools.find((t) => t.name === name)!
const getRecord = tool('gnubok_get_record')
const supabase = createQueuedMockSupabase().supabase as unknown as SupabaseClient

const LINKS: RecordLink[] = [{ relation: 'booked_by', record_ref: `journal_entry:${JE}`, basis: 'user_confirmed', via: 'pointer' }]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(readTransactionWithVouchers).mockReset()
  vi.mocked(transactionLinks).mockReset().mockResolvedValue(LINKS)
  vi.mocked(invoiceLinks).mockReset().mockResolvedValue(LINKS)
  vi.mocked(supplierInvoiceLinks).mockReset().mockResolvedValue(LINKS)
  vi.mocked(readSkattekontoRow).mockReset()
})

describe('gnubok_get_record ledger kinds', () => {
  it('a bank row is the get_transaction read with its links, for any company (no brain)', async () => {
    const core = { transaction_id: TX, journal_entry_id: JE, documents: [], verifikat: [], booked: true }
    vi.mocked(readTransactionWithVouchers).mockResolvedValue(core as never)
    const out = (await getRecord.execute({ record_ref: `transaction:${TX}` }, CO, 'user-1', supabase)) as Record<string, unknown>
    expect(readTransactionWithVouchers).toHaveBeenCalledWith(supabase, CO, TX)
    expect(transactionLinks).toHaveBeenCalledWith(supabase, CO, core)
    expect(out).toEqual({ record_ref: `transaction:${TX}`, kind: 'transaction', transaction: { ...core, links: LINKS } })
  })

  it('a missing bank row is NOT_FOUND', async () => {
    vi.mocked(readTransactionWithVouchers).mockResolvedValue(null)
    await expect(getRecord.execute({ record_ref: `transaction:${TX}` }, CO, 'user-1', supabase)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(transactionLinks).not.toHaveBeenCalled()
  })

  it('an invoice is gnubok_get_invoice\'s own answer with its links, so the two cannot drift apart', async () => {
    const getInvoice = tool('gnubok_get_invoice')
    const core = { invoice_id: INV, status: 'paid', items: [], item_count: 0 }
    const spy = vi.spyOn(getInvoice, 'execute').mockResolvedValue(core)
    const out = (await getRecord.execute({ record_ref: `invoice:${INV}` }, CO, 'user-1', supabase)) as Record<string, unknown>
    expect(spy).toHaveBeenCalledWith({ invoice_id: INV }, CO, 'user-1', supabase)
    expect(invoiceLinks).toHaveBeenCalledWith(supabase, CO, INV)
    expect(out).toEqual({ record_ref: `invoice:${INV}`, kind: 'invoice', invoice: { ...core, links: LINKS } })
  })

  it('an invoice the company does not hold answers get_invoice\'s own refusal', async () => {
    vi.spyOn(tool('gnubok_get_invoice'), 'execute').mockRejectedValue(Object.assign(new Error('Invoice not found.'), { code: 'NOT_FOUND' }))
    await expect(getRecord.execute({ record_ref: `invoice:${INV}` }, CO, 'user-1', supabase)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a supplier invoice is gnubok_get_supplier_invoice\'s own answer with its links', async () => {
    const core = { supplier_invoice_id: SI, status: 'paid', items: [], item_count: 0, payments: [] }
    const spy = vi.spyOn(tool('gnubok_get_supplier_invoice'), 'execute').mockResolvedValue(core)
    const out = (await getRecord.execute({ record_ref: `supplier_invoice:${SI}` }, CO, 'user-1', supabase)) as Record<string, unknown>
    expect(spy).toHaveBeenCalledWith({ supplier_invoice_id: SI }, CO, 'user-1', supabase)
    expect(out).toEqual({ record_ref: `supplier_invoice:${SI}`, kind: 'supplier_invoice', supplier_invoice: { ...core, links: LINKS } })
  })

  it('a skattekonto row answers with its links, and NOT_FOUND when the company has none with the id', async () => {
    const row = { skattekonto_transaction_id: SKV, journal_entry_id: JE, links: LINKS }
    vi.mocked(readSkattekontoRow).mockResolvedValueOnce(row as never).mockResolvedValueOnce(null)
    const out = (await getRecord.execute({ record_ref: `skattekonto_transaction:${SKV}` }, CO, 'user-1', supabase)) as Record<string, unknown>
    expect(readSkattekontoRow).toHaveBeenCalledWith(supabase, CO, SKV)
    expect(out).toEqual({ record_ref: `skattekonto_transaction:${SKV}`, kind: 'skattekonto_transaction', skattekonto_transaction: row })
    await expect(getRecord.execute({ record_ref: `skattekonto_transaction:${SKV}` }, CO, 'user-1', supabase)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an unknown kind, naming every kind it opens', async () => {
    await expect(getRecord.execute({ record_ref: `customer:${INV}` }, CO, 'user-1', supabase)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('transaction|invoice|supplier_invoice|skattekonto_transaction'),
    })
  })

  it('the other archive tools still take the archive kinds only', async () => {
    const { parseRecordRef } = await import('../arkiv-tools')
    expect(() => parseRecordRef(`transaction:${TX}`)).toThrow(/document\|agreement\|party\|journal_entry\|fact/)
  })

  it('keeps the description inside 280 characters and names every kind', () => {
    expect(getRecord.description.length).toBeLessThanOrEqual(280)
    for (const kind of ['document', 'journal_entry', 'transaction', 'invoice', 'supplier_invoice', 'skattekonto_transaction', 'agreement', 'party', 'fact']) {
      expect(getRecord.description).toContain(kind)
    }
  })
})
