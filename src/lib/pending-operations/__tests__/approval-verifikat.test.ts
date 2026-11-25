/**
 * What approving a staged supplier invoice from the inbox would post, as the
 * card beside its Godkänn shows it: the approval's own conversion run as a dry
 * run, its registration verifikat, nothing now, or the approval's refusal in
 * both languages. Which proposals ask at all is verifikatBuiltAtApproval. The
 * whole path runs on real Postgres in tests/pg/inbox-approval-verifikat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

vi.mock('@/lib/operations/inbox-convert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations/inbox-convert')>()),
  convertInboxItemToSupplierInvoice: vi.fn(),
}))

import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { approvalVerifikat } from '../approval-verifikat'
import { verifikatBuiltAtApproval } from '../built-at-approval'

const ctx = { supabase: {} as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('approval-verifikat-test') }

const STAGED = {
  inbox_item_id: 'item-1',
  supplier_id: 'supplier-1',
  supplier_invoice_number: 'F-1',
  invoice_date: '2026-05-15',
  due_date: '2026-06-14',
  currency: 'SEK',
  exchange_rate: null,
  vat_treatment: 'standard_25',
  subtotal: 1000,
  vat_amount: 250,
  total: 1250,
  notes: null,
  items: [{ description: 'Rad', line_total: 1000, account_number: '6530', vat_rate: 0.25, vat_amount: 250 }],
}

const VERIFIKAT = {
  entry_date: '2026-05-15',
  lines: [
    { account_number: '6530', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2641', debit_amount: 250, credit_amount: 0 },
    { account_number: '2440', debit_amount: 0, credit_amount: 1250 },
  ],
  total_debit: 1250,
  total_credit: 1250,
}

const dryRun = (preview: Record<string, unknown>) => ({ ok: true as const, dryRun: true as const, preview })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('verifikatBuiltAtApproval', () => {
  it('a supplier invoice from the inbox: its rows are built at the click', () => {
    expect(verifikatBuiltAtApproval({ operation_type: 'create_supplier_invoice_from_inbox', params: STAGED })).toBe(true)
    expect(verifikatBuiltAtApproval({ operation_type: 'create_supplier_invoice_from_inbox' })).toBe(true)
  })

  it('a registration of an already-booked invoice posts none, and other types state their rows', () => {
    expect(verifikatBuiltAtApproval({ operation_type: 'create_supplier_invoice_from_inbox', params: { mode: 'register_booked' } })).toBe(false)
    expect(verifikatBuiltAtApproval({ operation_type: 'categorize_transaction', params: {} })).toBe(false)
    expect(verifikatBuiltAtApproval({ operation_type: 'create_invoice', params: {} })).toBe(false)
  })
})

describe('approvalVerifikat', () => {
  it('runs the approval\'s conversion as a dry run, on what was staged, held to the total the approver saw', async () => {
    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue(dryRun({ verifikat: VERIFIKAT }))
    expect(await approvalVerifikat(ctx, STAGED)).toEqual({ posts: 'verifikat', verifikat: [VERIFIKAT] })
    const [passedCtx, item, body, options] = vi.mocked(convertInboxItemToSupplierInvoice).mock.calls[0]!
    expect(passedCtx).toBe(ctx)
    expect(item).toBe('item-1')
    expect(body).toMatchObject({ supplier_id: 'supplier-1', supplier_invoice_number: 'F-1', items: [{ account_number: '6530', vat_amount: 250 }] })
    expect(options).toEqual({ dryRun: true, approvedTotal: 1250, withVerifikat: true })
  })

  it('nothing now: kontantmetoden or deferred booking', async () => {
    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue(dryRun({ verifikat: null }))
    expect(await approvalVerifikat(ctx, STAGED)).toEqual({ posts: 'nothing' })
  })

  it('another currency staged without a rate: known only at the click, and Riksbanken is not asked from a hover', async () => {
    expect(await approvalVerifikat(ctx, { ...STAGED, currency: 'EUR', exchange_rate: null })).toEqual({ posts: 'at_approval' })
    expect(convertInboxItemToSupplierInvoice).not.toHaveBeenCalled()

    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue(dryRun({ verifikat: VERIFIKAT }))
    expect(await approvalVerifikat(ctx, { ...STAGED, currency: 'EUR', exchange_rate: 11.43 })).toMatchObject({ posts: 'verifikat' })
    expect(vi.mocked(convertInboxItemToSupplierInvoice).mock.calls[0]![2]).toMatchObject({ currency: 'EUR', exchange_rate: 11.43 })
  })

  it('a refusal in both languages, as the registry says it', async () => {
    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue({ ok: false, code: 'SI_CREATE_NO_FISCAL_PERIOD', details: { invoiceDate: '2026-05-15' } })
    const entry = getErrorEntry('SI_CREATE_NO_FISCAL_PERIOD')!
    expect(await approvalVerifikat(ctx, STAGED)).toEqual({
      posts: 'refused',
      code: 'SI_CREATE_NO_FISCAL_PERIOD',
      message_sv: entry.message_sv,
      message_en: entry.message_en,
    })
  })

  it('a refusal that names its own numbers keeps them in Swedish', async () => {
    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue({
      ok: false,
      code: 'SI_CREATE_TOTALS_MISMATCH',
      details: { gap: 100 },
      messageSv: 'Raderna går inte ihop. Raderna inklusive moms: 1250, totalbelopp: 1350.',
    })
    const answer = await approvalVerifikat(ctx, STAGED)
    expect(answer).toMatchObject({ posts: 'refused', code: 'SI_CREATE_TOTALS_MISMATCH', message_sv: 'Raderna går inte ihop. Raderna inklusive moms: 1250, totalbelopp: 1350.' })
    expect(answer.posts === 'refused' && answer.message_en).toBe(getErrorEntry('SI_CREATE_TOTALS_MISMATCH')!.message_en)
  })

  it('an account the engine refuses: its own code, naming the account', async () => {
    vi.mocked(convertInboxItemToSupplierInvoice).mockResolvedValue({ ok: false, code: 'SI_CREATE_FAILED', error: new AccountsNotInChartError(['6530']) })
    const answer = await approvalVerifikat(ctx, STAGED)
    expect(answer).toMatchObject({ posts: 'refused', code: 'ACCOUNTS_NOT_IN_CHART' })
    expect(answer.posts === 'refused' && answer.message_sv).toContain('6530')
  })

  it('a staged conversion that cannot run is refused before anything is read', async () => {
    expect(await approvalVerifikat(ctx, { ...STAGED, items: [{ description: 'Rad', line_total: 1000 }] })).toMatchObject({
      posts: 'refused',
      code: 'SI_CREATE_ITEM_ACCOUNT_MISSING',
    })
    expect(await approvalVerifikat(ctx, { ...STAGED, supplier_invoice_number: '' })).toMatchObject({ posts: 'refused', code: 'SI_CREATE_INVALID_INPUT' })
    expect(convertInboxItemToSupplierInvoice).not.toHaveBeenCalled()
  })
})
