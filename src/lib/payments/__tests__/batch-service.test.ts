import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2060: the diagnostic behind create_failed is a log line, so the logger is
// the assertion surface. The REAL logger module is kept and only `error` is
// swapped (same shape as lib/reconciliation/__tests__/bank-reconciliation.test.ts):
// a file-global stub would throw from any module in this file's graph that
// calls a level the stub omitted.
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      error: logError,
    }),
  }
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  batchFileBytes,
  createSupplierPaymentBatch,
  previewSupplierPaymentBatch,
  renderSupplierPaymentBatchFile,
} from '@/lib/payments/batch-service'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'

const COMPANY_ID = 'c0000000-0000-0000-0000-000000000001'
const USER_ID = 'u0000000-0000-0000-0000-000000000001'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const companyRow = { name: 'Testbolaget AB', org_number: '556677-8899' }
const settingsRow = {
  company_name: 'Testbolaget AB',
  org_number: '556677-8899',
  city: 'Stockholm',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  bankgiro: '991-2346',
  clearing_number: null,
  bank_name: null,
}

/** A Svea Bank company: its file upload takes Bankgirot's LB file and no pain.001 (crm#1424). */
const SVEA_SETTINGS = { ...settingsRow, iban: 'SE4496600000000012345678', bic: 'SVEASESS' }

/** The two ids Swedbank assigns, in the formats its MIG 2.0 states. */
const SWEDBANK_IDS = {
  swedbank_signer_id: '123456789ORI0001',
  swedbank_corporate_pay_id: '123456789CPO0001',
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    status: 'approved',
    approved_at: '2026-08-01T10:00:00Z',
    due_date: '2099-08-20',
    remaining_amount: 737.5,
    currency: 'SEK',
    is_credit_note: false,
    payment_reference: null,
    supplier_invoice_number: 'CD3014794407',
    supplier: {
      id: 'sup-1',
      name: 'Derome Bygg & Industri AB',
      city: 'Veddige',
      bankgiro: '5050-1055',
      plusgiro: null,
      bank_account: null,
      clearing_number: null,
      account_number: null,
    },
    ...overrides,
  }
}

/** The default supplier with its bankgiro swapped for another payee field. */
function supplierPaying(payee: Record<string, unknown>) {
  return { ...invoiceRow().supplier, bankgiro: null, ...payee }
}

/** An invoice per payee type: bankgiro (the default), plusgiro, bank account. */
function invoicesToEveryPayeeType() {
  return [
    invoiceRow({ id: 'inv-bg' }),
    invoiceRow({ id: 'inv-pg', supplier: supplierPaying({ plusgiro: '123456-6' }) }),
    invoiceRow({ id: 'inv-acct', supplier: supplierPaying({ clearing_number: '6000', account_number: '123456789' }) }),
  ]
}

function batchRow(overrides: Record<string, unknown> = {}): SupplierPaymentBatch {
  return {
    id: 'b0000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    user_id: USER_ID,
    format: 'pain001',
    status: 'created',
    currency: 'SEK',
    total_amount: 737.5,
    item_count: 1,
    msg_id: 'ACCOUNTED-5566778899-BB0000000',
    debtor_snapshot: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      iban: 'SE3550000000054910000003',
      bic: 'ESSESESS',
    },
    file_generated_at: null,
    download_count: 0,
    cancelled_at: null,
    cancelled_by: null,
    created_at: '2026-08-10T12:00:00Z',
    updated_at: '2026-08-10T12:00:00Z',
    ...overrides,
  } as SupplierPaymentBatch
}

describe('previewSupplierPaymentBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('returns eligible lines with payee, reference and totals', async () => {
    const mock = createQueuedMockSupabase()
    // from() order: supplier_invoices, batch items (active map), companies, settings
    mock.enqueueMany([
      { data: [invoiceRow()] },
      { data: [] },
      { data: companyRow },
      { data: settingsRow },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-1'] },
    )

    expect(preview.excluded).toEqual([])
    expect(preview.eligible).toHaveLength(1)
    expect(preview.eligible[0]).toMatchObject({
      id: 'inv-1',
      supplier_name: 'Derome Bygg & Industri AB',
      amount: 737.5,
      payment_date: '2099-08-20',
      payee: { type: 'bankgiro', label: 'BG 5050-1055' },
      reference: { type: 'invoice_number', value: 'CD3014794407' },
      warnings: [],
    })
    expect(preview.total).toBe(737.5)
    expect(preview.debtor_ok).toBe(true)
  })

  it('excludes an invoice a bank payment order still covers, by name', async () => {
    const mock = createQueuedMockSupabase()
    // from() order: supplier_invoices, batch items, companies, settings, open payment orders
    mock.enqueueMany([
      { data: [invoiceRow()] },
      { data: [] },
      { data: companyRow },
      { data: settingsRow },
      { data: [{ supplier_invoice_id: 'inv-1', status: 'awaiting_signature', supplier_invoice_payment_id: null }] },
    ])

    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['inv-1'] })

    expect(preview.eligible).toEqual([])
    expect(preview.excluded).toEqual([{ id: 'inv-1', reason: 'in_bank_payment' }])
  })

  it('leaves out an invoice that states bank details nobody approved for the supplier, as payee_unconfirmed', async () => {
    const mock = createQueuedMockSupabase()
    // from() order: supplier_invoices, batch items, companies, settings, open payment orders, the attest policy, then the decisions.
    mock.enqueueMany([
      {
        data: [
          invoiceRow({ supplier_id: 'sup-1', payee_bankgiro: '9020-0007' }),
          invoiceRow({ id: 'inv-2', supplier_id: 'sup-1', payee_bankgiro: '5402-0102' }),
          invoiceRow({ id: 'inv-3', supplier_id: 'sup-1', payee_bankgiro: '5050-1055' }),
        ],
      },
      { data: [] },
      { data: companyRow },
      { data: settingsRow },
      { data: [] },
      { data: null }, // attest policy: none
      { data: [{ supplier_id: 'sup-1', payee_key: 'bankgiro:54020102', decision: 'confirmed', decided_at: '2026-10-14T09:00:00Z' }] },
    ])

    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, {
      ids: ['inv-1', 'inv-2', 'inv-3'],
    })

    expect(preview.excluded).toEqual([{ id: 'inv-1', reason: 'payee_unconfirmed' }])
    // A confirmed account pays as today: the file pays the card's account.
    expect(preview.eligible.map((line) => [line.id, line.payee.label])).toEqual([
      ['inv-2', 'BG 5050-1055'],
      ['inv-3', 'BG 5050-1055'],
    ])
  })

  it('excludes ineligible invoices with a reason and unknown ids as not_found', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [invoiceRow({ status: 'paid' })] },
      { data: [] },
      { data: companyRow },
      { data: settingsRow },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-1', 'inv-ghost'] },
    )

    expect(preview.eligible).toEqual([])
    expect(preview.excluded).toEqual([
      { id: 'inv-1', reason: 'not_payable' },
      { id: 'inv-ghost', reason: 'not_found' },
    ])
  })

  it('fails closed when the active-batch lookup errors', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [invoiceRow()] },
      { error: { message: 'relation missing' } },
      { data: companyRow },
      { data: settingsRow },
    ])

    await expect(
      previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, {
        ids: ['inv-1'],
      }),
    ).rejects.toBeTruthy()
  })

  it('reports a missing debtor IBAN without blocking the preview', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [invoiceRow()] },
      { data: [] },
      { data: companyRow },
      { data: { ...settingsRow, iban: null } },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-1'] },
    )

    expect(preview.debtor_ok).toBe(false)
    expect(preview.debtor_missing).toBe('iban')
    expect(preview.eligible).toHaveLength(1)
  })

  it('asks a Swedbank company for the ids Swedbank assigns without blocking the preview', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: companyRow },
      { data: { ...settingsRow, bic: 'SWEDSESS' } },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-bg', 'inv-pg', 'inv-acct'] },
    )

    expect(preview.debtor_ok).toBe(false)
    expect(preview.debtor_missing).toBe('swedbank_ids')
    // The ids lead to an ISO 2.0 file only, so the giro payees are left out already.
    expect(preview.eligible.map((line) => line.id)).toEqual(['inv-acct'])
  })

  // crm#1156: Swedbank's ISO 2.0 service pays to bank accounts only.
  it('leaves bankgiro and plusgiro payees out of a Swedbank ISO 2.0 file and keeps the bank-account payee', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: companyRow },
      { data: { ...settingsRow, bic: 'SWEDSESS', ...SWEDBANK_IDS } },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-bg', 'inv-pg', 'inv-acct'] },
    )

    expect(preview.debtor_ok).toBe(true)
    expect(preview.eligible.map((line) => [line.id, line.payee.type])).toEqual([['inv-acct', 'bank_account']])
    expect(preview.excluded).toEqual([
      { id: 'inv-bg', reason: 'swedbank_iso2_giro_payee' },
      { id: 'inv-pg', reason: 'swedbank_iso2_giro_payee' },
    ])
    expect(preview.total).toBe(737.5)
  })

  it('keeps every payee type at any other bank, Swedbank ids still saved or not', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: companyRow },
      { data: { ...settingsRow, ...SWEDBANK_IDS } }, // ESSESESS
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-bg', 'inv-pg', 'inv-acct'] },
    )

    expect(preview.debtor_ok).toBe(true)
    expect(preview.format).toBe('pain001')
    expect(preview.eligible.map((line) => line.payee.type)).toEqual(['bankgiro', 'plusgiro', 'bank_account'])
    expect(preview.excluded).toEqual([])
  })

  // crm#1424: Svea Bank answers a pain.001 upload "Content is neither BgLon or LbFile".
  it('makes a Svea Bank company an LB file, paying bankgiro and plusgiro payees and leaving the bank-account payee out', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: companyRow },
      { data: SVEA_SETTINGS },
    ])

    const preview = await previewSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      { ids: ['inv-bg', 'inv-pg', 'inv-acct'] },
    )

    expect(preview.format).toBe('bg_lb')
    expect(preview.debtor_ok).toBe(true)
    expect(preview.eligible.map((line) => [line.id, line.payee.type])).toEqual([['inv-bg', 'bankgiro'], ['inv-pg', 'plusgiro']])
    expect(preview.excluded).toEqual([{ id: 'inv-acct', reason: 'lb_bank_account_payee' }])
  })

  it.each(['SVEASES1', 'sveases1xxx', 'SVEASESSXXX'])('knows Svea Bank by its SWIFT BIC and Open Payments\' alike: %s', async (bic) => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([{ data: [invoiceRow()] }, { data: [] }, { data: companyRow }, { data: { ...SVEA_SETTINGS, bic } }])

    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['inv-1'] })

    expect(preview.format).toBe('bg_lb')
  })

  it('asks a Svea Bank company without a bankgiro for one, since its LB file is sent from it', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: [invoiceRow()] },
      { data: [] },
      { data: companyRow },
      { data: { ...SVEA_SETTINGS, bankgiro: null } },
    ])

    const preview = await previewSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, { ids: ['inv-1'] })

    expect(preview.format).toBe('bg_lb')
    expect(preview.debtor_ok).toBe(false)
    expect(preview.debtor_missing).toBe('bankgiro')
    expect(preview.eligible.map((line) => line.id)).toEqual(['inv-1'])
  })
})

describe('createSupplierPaymentBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // Queue order for create (shared between from() and rpc()): companies,
  // settings (debtor first), then supplier_invoices, batch items (active-batch
  // fast path), then the single create_supplier_payment_batch RPC call that
  // writes header + items atomically.
  it('refuses an invoice a bank payment order still covers before calling the RPC', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [{ supplier_invoice_id: 'inv-1', status: 'executed', supplier_invoice_payment_id: null }] },
    ])

    const result = await createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
      items: [{ supplier_invoice_id: 'inv-1' }],
    })

    expect(result).toEqual({ ok: false, code: 'ineligible', details: [{ id: 'inv-1', reason: 'in_bank_payment' }] })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('creates a batch through the atomic RPC with snapshotted payee rows and a derived msg_id', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: true, batch: batchRow() })

    // No direct table writes: the RPC is the only write path.
    expect(mock.findCall('supplier_payment_batches', 'insert')).toBeUndefined()
    expect(mock.findCall('supplier_payment_batch_items', 'insert')).toBeUndefined()

    expect(mock.supabase.rpc).toHaveBeenCalledTimes(1)
    const [fnName, args] = mock.supabase.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(fnName).toBe('create_supplier_payment_batch')
    expect(args).toMatchObject({
      p_company_id: COMPANY_ID,
      p_user_id: USER_ID,
      p_format: 'pain001',
      p_confirm_already_batched: false,
      p_debtor_snapshot: {
        name: 'Testbolaget AB',
        org_number: '556677-8899',
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESS',
        bankgiro: '9912346',
        city: 'Stockholm',
      },
    })
    expect(args.p_batch_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const msgId = args.p_msg_id as string
    expect(msgId.startsWith('ACCOUNTED-5566778899-B')).toBe(true)
    expect(msgId.length).toBeLessThanOrEqual(35)

    const items = args.p_items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      supplier_invoice_id: 'inv-1',
      amount: 737.5,
      payment_date: '2099-08-20',
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_plusgiro: null,
      payee_clearing: null,
      payee_account: null,
      payee_name: 'Derome Bygg & Industri AB',
      payee_city: 'Veddige',
      reference_type: 'invoice_number',
      reference: 'CD3014794407',
    })
    // batch_id and company_id come from p_batch_id / p_company_id in SQL.
    expect(items[0]).not.toHaveProperty('batch_id')
    expect(items[0]).not.toHaveProperty('company_id')
  })

  it('maps an in-transaction already_batched refusal from the RPC onto the same result', async () => {
    // The app-side pre-check saw no active batch (empty map), but a concurrent
    // create committed one before the RPC took its lock: the RPC's recheck
    // refuses and the service must surface it exactly like the pre-check does.
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      {
        data: {
          ok: false,
          code: 'already_batched',
          details: [{ id: 'inv-1', batch_id: 'batch-9' }],
        },
      },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({
      ok: false,
      code: 'already_batched',
      details: [{ id: 'inv-1', batch_id: 'batch-9' }],
    })
  })

  it('maps in-transaction ineligible and amount refusals from the RPC', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: false, code: 'ineligible', details: [{ id: 'inv-1', reason: 'not_payable' }] } },
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: false, code: 'amount_exceeds_remaining', details: [{ id: 'inv-1' }] } },
    ])
    const input = { items: [{ supplier_invoice_id: 'inv-1' }] }

    const ineligible = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(ineligible).toEqual({
      ok: false,
      code: 'ineligible',
      details: [{ id: 'inv-1', reason: 'not_payable' }],
    })

    const excessive = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(excessive).toEqual({
      ok: false,
      code: 'amount_exceeds_remaining',
      details: [{ id: 'inv-1' }],
    })
  })

  it('maps an RPC error (constraint violation, guard) to create_failed and logs the raw error', async () => {
    const mock = createQueuedMockSupabase()
    const rpcError = {
      code: '23514',
      message:
        'new row for relation "supplier_payment_batch_items" violates check constraint "supplier_payment_batch_items_payee_fields_match"',
      details: 'Failing row contains (...).',
      hint: null,
    }
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { error: rpcError },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    // The client contract is unchanged: a generic create_failed, nothing else.
    expect(result).toEqual({ ok: false, code: 'create_failed' })

    // The diagnosis lives in the log (#2060): SQLSTATE and message only, keyed
    // by company, batch and item count. Exact match on purpose: details and
    // hint (where Postgres quotes row data), the debtor snapshot and the item
    // rows must never ride along.
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('create_supplier_payment_batch RPC failed', {
      companyId: COMPANY_ID,
      batchId: expect.stringMatching(UUID_RE),
      itemCount: 1,
      rpcError: { code: '23514', message: rpcError.message },
    })
    const [, ctx] = logError.mock.calls[0] as [string, Record<string, unknown>]
    expect(ctx.batchId).toBe((mock.supabase.rpc.mock.calls[0][1] as { p_batch_id: string }).p_batch_id)
  })

  it('never logs details or hint: an IBAN and a payee name there cannot reach the log, code and message do', async () => {
    const mock = createQueuedMockSupabase()
    const IBAN = 'SE4550000000058398257466'
    const rpcError = {
      code: '23514',
      message:
        'new row for relation "supplier_payment_batch_items" violates check constraint "supplier_payment_batch_items_payee_fields_match"',
      // Where Postgres quotes the entire failing row (payee name, account).
      details:
        'Failing row contains (b0000000-0000-0000-0000-000000000001, c0000000-0000-0000-0000-000000000001, ' +
        `737.50, 2099-08-15, bank_account, null, null, 5000, ${IBAN}, Anna Andersson, invoice_number, CD3014794407).`,
      hint: `Check the payee fields for Anna Andersson (${IBAN}).`,
    }
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { error: rpcError },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )
    expect(result).toEqual({ ok: false, code: 'create_failed' })

    expect(logError).toHaveBeenCalledTimes(1)
    const [, ctx] = logError.mock.calls[0] as [string, Record<string, unknown>]
    // Nothing from details or hint, in any shape, anywhere in the context.
    const serialized = JSON.stringify(ctx)
    expect(serialized).not.toContain(IBAN)
    expect(serialized).not.toContain('Anna Andersson')
    expect(serialized).not.toContain('Failing row')
    expect(serialized).not.toContain(rpcError.hint)
    expect(ctx).not.toHaveProperty(['rpcError', 'details'])
    expect(ctx).not.toHaveProperty(['rpcError', 'hint'])
    // Only the two fields with diagnostic value, verbatim.
    expect(ctx.rpcError).toEqual({ code: '23514', message: rpcError.message })
  })

  it('logs a PostgREST schema-cache miss (PGRST202) the same way, still as create_failed', async () => {
    const mock = createQueuedMockSupabase()
    const rpcError = {
      code: 'PGRST202',
      message:
        'Could not find the function public.create_supplier_payment_batch(p_batch_id, ...) in the schema cache',
      details: 'Searched for the function public.create_supplier_payment_batch with parameters ...',
      hint: 'Perhaps you meant to call the function public.create_supplier_payment_batch without parameters',
    }
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { error: rpcError },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'create_failed' })
    expect(logError).toHaveBeenCalledWith(
      'create_supplier_payment_batch RPC failed',
      expect.objectContaining({
        companyId: COMPANY_ID,
        itemCount: 1,
        rpcError: { code: 'PGRST202', message: rpcError.message },
      }),
    )
  })

  it('maps an unknown RPC refusal code and an empty RPC payload to create_failed', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: false, code: 'something_new' } },
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: null },
    ])
    const input = { items: [{ supplier_invoice_id: 'inv-1' }] }

    const unknown = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(unknown).toEqual({ ok: false, code: 'create_failed' })
    // An unmapped refusal code is logged with the code itself, so a code added
    // in SQL without a client mapping cannot vanish behind create_failed.
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenLastCalledWith(
      'create_supplier_payment_batch RPC refused with an unmapped code',
      {
        companyId: COMPANY_ID,
        batchId: expect.stringMatching(UUID_RE),
        itemCount: 1,
        rpcCode: 'something_new',
        rpcDetails: undefined,
      },
    )

    const empty = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(empty).toEqual({ ok: false, code: 'create_failed' })
    expect(logError).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenLastCalledWith(
      'create_supplier_payment_batch RPC returned no payload',
      { companyId: COMPANY_ID, batchId: expect.stringMatching(UUID_RE), itemCount: 1 },
    )
  })

  it('does not log when the RPC succeeds or refuses with a mapped code', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: false, code: 'already_batched', details: [{ id: 'inv-1', batch_id: 'b' }] } },
    ])
    const input = { items: [{ supplier_invoice_id: 'inv-1' }] }

    const created = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(created.ok).toBe(true)
    const refused = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(refused).toMatchObject({ ok: false, code: 'already_batched' })
    expect(logError).not.toHaveBeenCalled()
  })

  it('rejects the whole batch when any invoice is ineligible', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow(), invoiceRow({ id: 'inv-2', currency: 'EUR' })] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      {
        items: [{ supplier_invoice_id: 'inv-1' }, { supplier_invoice_id: 'inv-2' }],
      },
    )

    expect(result).toEqual({
      ok: false,
      code: 'ineligible',
      details: [{ id: 'inv-2', reason: 'foreign_currency' }],
    })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a create naming an invoice whose stated bank details a person rejected', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow({ supplier_id: 'sup-1', payee_bankgiro: '9020-0007' })] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: [{ supplier_id: 'sup-1', payee_key: 'bankgiro:90200007', decision: 'rejected', decided_at: '2026-10-14T09:00:00Z' }] },
    ])

    const result = await createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
      items: [{ supplier_invoice_id: 'inv-1' }],
    })

    expect(result).toEqual({ ok: false, code: 'ineligible', details: [{ id: 'inv-1', reason: 'payee_rejected' }] })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an amount override above the remaining amount', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1', amount: 800 }] },
    )

    expect(result).toEqual({
      ok: false,
      code: 'amount_exceeds_remaining',
      details: [{ id: 'inv-1' }],
    })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses an invoice already in an active batch unless confirmed', async () => {
    const mock = createQueuedMockSupabase()
    const activeItems = [
      { supplier_invoice_id: 'inv-1', batch: { id: 'batch-9', status: 'created' } },
    ]
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: activeItems },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({
      ok: false,
      code: 'already_batched',
      details: [{ id: 'inv-1', batch_id: 'batch-9' }],
    })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('proceeds past an active batch when explicitly confirmed and forwards the confirmation to the RPC', async () => {
    const mock = createQueuedMockSupabase()
    const activeItems = [
      { supplier_invoice_id: 'inv-1', batch: { id: 'batch-9', status: 'created' } },
    ]
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: activeItems },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      {
        items: [{ supplier_invoice_id: 'inv-1' }],
        confirm_already_batched: true,
      },
    )

    expect(result.ok).toBe(true)
    expect(mock.supabase.rpc).toHaveBeenCalledWith(
      'create_supplier_payment_batch',
      expect.objectContaining({ p_confirm_already_batched: true }),
    )
  })

  it('fails closed when the active-batch lookup errors instead of skipping the guard', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { error: { message: 'relation missing' } },
    ])

    await expect(
      createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
        items: [{ supplier_invoice_id: 'inv-1' }],
      }),
    ).rejects.toBeTruthy()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('fails up front when the debtor is incomplete', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([{ data: companyRow }, { data: { ...settingsRow, iban: null } }])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'iban' })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('drops an invalid company bankgiro from the snapshot instead of debiting it', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: { ...settingsRow, bankgiro: '1234-5678' } },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result.ok).toBe(true)
    const args = mock.supabase.rpc.mock.calls[0][1] as {
      p_debtor_snapshot: { bankgiro: string | null }
    }
    expect(args.p_debtor_snapshot.bankgiro).toBeNull()
  })

  it('requires an organisation number for the InitgPty OrgId', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: { ...companyRow, org_number: null } },
      { data: { ...settingsRow, org_number: null } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'org_number' })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses when no BIC is saved and none can be derived: the debtor bank must be known', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: { ...settingsRow, bic: null, clearing_number: null, bank_name: 'Testbanken' } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'bic' })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('derives the Danske Bank BIC from the clearing number when none is saved, and the file then debits the IBAN', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      // No BIC in settings; 1234 is in Danske Bank's clearing series.
      { data: { ...settingsRow, iban: 'SE72 1200 0000 0122 0011 1878', bic: null, clearing_number: '1234' } },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result.ok).toBe(true)
    const args = mock.supabase.rpc.mock.calls[0][1] as {
      p_debtor_snapshot: SupplierPaymentBatch['debtor_snapshot']
    }
    // The company bankgiro still rides along in the snapshot: the bank rule lives in the generator.
    expect(args.p_debtor_snapshot).toMatchObject({
      iban: 'SE7212000000012200111878',
      bic: 'DABASESX',
      bankgiro: '9912346',
    })

    const file = renderSupplierPaymentBatchFile(
      batchRow({ debtor_snapshot: args.p_debtor_snapshot }),
      [storedBankgiroItem()],
    )
    const debtorAccount = file.content.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/)![0]
    expect(debtorAccount).toContain('<IBAN>SE7212000000012200111878</IBAN>')
    expect(debtorAccount).not.toContain('BGNR')
    expect(file.content).toContain('<BIC>DABASESX</BIC>')
  })

  it('refuses a Swedbank debtor without both ids Swedbank assigns, since Swedbank refuses that file', async () => {
    const partial = [
      {},
      { swedbank_signer_id: SWEDBANK_IDS.swedbank_signer_id },
      { swedbank_corporate_pay_id: SWEDBANK_IDS.swedbank_corporate_pay_id },
      { swedbank_signer_id: '  ', swedbank_corporate_pay_id: SWEDBANK_IDS.swedbank_corporate_pay_id },
    ]
    for (const ids of partial) {
      const mock = createQueuedMockSupabase()
      mock.enqueueMany([{ data: companyRow }, { data: { ...settingsRow, bic: 'swedsessxxx', ...ids } }])

      const result = await createSupplierPaymentBatch(
        mock.supabase as unknown as SupabaseClient,
        COMPANY_ID,
        USER_ID,
        { items: [{ supplier_invoice_id: 'inv-1' }] },
      )

      expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'swedbank_ids' })
      expect(mock.supabase.rpc).not.toHaveBeenCalled()
    }
  })

  it('treats a company whose clearing number is Swedbank or a savings bank as Swedbank when no BIC is saved', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([{ data: companyRow }, { data: { ...settingsRow, bic: null, clearing_number: '8327-9' } }])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'swedbank_ids' })
  })

  it('snapshots the Swedbank ids, and the file names the sender and the agreement by them', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: { ...settingsRow, bic: 'SWEDSESS', ...SWEDBANK_IDS } },
      { data: [invoiceRow({ supplier: supplierPaying({ clearing_number: '6000', account_number: '123456789' }) })] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result.ok).toBe(true)
    const args = mock.supabase.rpc.mock.calls[0][1] as {
      p_debtor_snapshot: SupplierPaymentBatch['debtor_snapshot']
    }
    expect(args.p_debtor_snapshot).toMatchObject({ bic: 'SWEDSESS', ...SWEDBANK_IDS })

    const file = renderSupplierPaymentBatchFile(
      batchRow({ debtor_snapshot: args.p_debtor_snapshot }),
      [
        {
          ...storedBankgiroItem(),
          payee_type: 'bank_account',
          payee_bankgiro: null,
          payee_clearing: '6000',
          payee_account: '123456789',
        },
      ],
    )
    const flat = file.content.replace(/\s+/g, '')
    const initiator = flat.match(/<InitgPty>.*?<\/InitgPty>/)![0]
    expect(initiator).toContain('<Othr><Id>123456789ORI0001</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    expect(initiator).not.toContain('5566778899')
    const debtor = flat.match(/<Dbtr>.*?<\/Dbtr>/)![0]
    expect(debtor).toContain('<Othr><Id>123456789CPO0001</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    expect(debtor).not.toContain('5566778899')
  })

  it.each([
    ['a bankgiro payee alone', ['inv-bg']],
    ['a batch mixing it with a bank-account payee', ['inv-acct', 'inv-bg', 'inv-pg']],
  ])('refuses %s in a Swedbank ISO 2.0 file before calling the RPC (crm#1156)', async (_case, ids) => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: { ...settingsRow, bic: 'SWEDSESS', ...SWEDBANK_IDS } },
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: ids.map((id) => ({ supplier_invoice_id: id })) },
    )

    expect(result).toEqual({
      ok: false,
      code: 'ineligible',
      details: ids
        .filter((id) => id !== 'inv-acct')
        .map((id) => ({ id, reason: 'swedbank_iso2_giro_payee' })),
    })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('creates a Svea Bank company\'s batch as an LB file through the same RPC', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: SVEA_SETTINGS },
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow({ format: 'bg_lb' }) } },
    ])

    const result = await createSupplierPaymentBatch(mock.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
      items: [{ supplier_invoice_id: 'inv-1' }],
    })

    expect(result).toMatchObject({ ok: true, batch: { format: 'bg_lb' } })
    const [, args] = mock.supabase.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(args).toMatchObject({ p_format: 'bg_lb', p_debtor_snapshot: { bic: 'SVEASESS', bankgiro: '9912346' } })
  })

  it('refuses a bank-account payee in a Svea Bank LB file, and a Svea Bank company without a bankgiro, before the RPC', async () => {
    const mixed = createQueuedMockSupabase()
    mixed.enqueueMany([
      { data: companyRow },
      { data: SVEA_SETTINGS },
      { data: invoicesToEveryPayeeType() },
      { data: [] },
      { data: [] },
      { data: null },
    ])
    expect(
      await createSupplierPaymentBatch(mixed.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
        items: ['inv-bg', 'inv-acct'].map((id) => ({ supplier_invoice_id: id })),
      }),
    ).toEqual({ ok: false, code: 'ineligible', details: [{ id: 'inv-acct', reason: 'lb_bank_account_payee' }] })
    expect(mixed.supabase.rpc).not.toHaveBeenCalled()

    const noBankgiro = createQueuedMockSupabase()
    noBankgiro.enqueueMany([{ data: companyRow }, { data: { ...SVEA_SETTINGS, bankgiro: '' } }])
    expect(
      await createSupplierPaymentBatch(noBankgiro.supabase as unknown as SupabaseClient, COMPANY_ID, USER_ID, {
        items: [{ supplier_invoice_id: 'inv-1' }],
      }),
    ).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'bankgiro' })
    expect(noBankgiro.supabase.rpc).not.toHaveBeenCalled()
  })

  it('leaves the Swedbank ids out of another bank\'s snapshot, even when they are still saved', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: { ...settingsRow, ...SWEDBANK_IDS } }, // ESSESESS: the company moved to SEB
      { data: [invoiceRow()] },
      { data: [] },
      { data: [] }, // open bank payment orders: none
      { data: null }, // attest policy: none
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result.ok).toBe(true)
    const args = mock.supabase.rpc.mock.calls[0][1] as { p_debtor_snapshot: Record<string, unknown> }
    expect(args.p_debtor_snapshot).not.toHaveProperty('swedbank_signer_id')
    expect(args.p_debtor_snapshot).not.toHaveProperty('swedbank_corporate_pay_id')
  })
})

/** One stored batch line paying a bankgiro number by invoice number. */
function storedBankgiroItem(): SupplierPaymentBatchItem {
  return {
    id: 'item-1',
    batch_id: 'b0000000-0000-0000-0000-000000000001',
    company_id: COMPANY_ID,
    supplier_invoice_id: 'inv-1',
    amount: 737.5,
    payment_date: '2026-08-15',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_name: 'Derome Bygg & Industri AB',
    payee_city: 'Veddige',
    reference_type: 'invoice_number',
    reference: 'CD3014794407',
    created_at: '2026-08-10T12:00:00Z',
  }
}

describe('renderSupplierPaymentBatchFile', () => {
  it('renders a deterministic pain.001 file from stored rows alone', () => {
    const batch = batchRow()
    const items: SupplierPaymentBatchItem[] = [
      {
        id: 'item-1',
        batch_id: batch.id,
        company_id: COMPANY_ID,
        supplier_invoice_id: 'inv-1',
        amount: 737.5,
        payment_date: '2026-08-15',
        payee_type: 'bankgiro',
        payee_bankgiro: '50501055',
        payee_plusgiro: null,
        payee_clearing: null,
        payee_account: null,
        payee_name: 'Derome Bygg & Industri AB',
        payee_city: null,
        reference_type: 'invoice_number',
        reference: 'CD3014794407',
        created_at: '2026-08-10T12:00:00Z',
      },
    ]

    const first = renderSupplierPaymentBatchFile(batch, items)
    const second = renderSupplierPaymentBatchFile(batch, items)

    expect(first.content).toBe(second.content)
    expect(first.content).toContain(`<MsgId>${batch.msg_id}</MsgId>`)
    expect(first.content).toContain('<CreDtTm>2026-08-10T12:00:00Z</CreDtTm>')
    expect(first.contentType).toBe('application/xml; charset=utf-8')
    expect(first.filename).toBe('betalfil_20260810_b0000000.xml')
  })

  it('refuses a format the renderer does not support', () => {
    expect(() => renderSupplierPaymentBatchFile(batchRow({ format: 'xml' }), [])).toThrow('Filformatet stöds inte')
  })

  it('renders a stored LB batch from its rows alone: ISO 8859-1 text from the company bankgiro, written on the creation day', () => {
    const batch = batchRow({
      format: 'bg_lb',
      // 23:30 UTC on 2026-08-10 is already 2026-08-11 in Stockholm: the write date.
      created_at: '2026-08-10T23:30:00Z',
      debtor_snapshot: { name: 'Testbolaget AB', org_number: '556677-8899', iban: 'SE4496600000000012345678', bic: 'SVEASESS', bankgiro: '9912346', city: null },
    })
    const item = (overrides: Partial<SupplierPaymentBatchItem>): SupplierPaymentBatchItem => ({
      id: 'item-1',
      batch_id: batch.id,
      company_id: COMPANY_ID,
      supplier_invoice_id: 'inv-1',
      amount: 737.5,
      payment_date: '2026-08-15',
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_plusgiro: null,
      payee_clearing: null,
      payee_account: null,
      payee_name: 'Åkeri Öst AB',
      payee_city: null,
      reference_type: 'ocr',
      reference: '55601234566',
      created_at: '2026-08-10T23:30:00Z',
      ...overrides,
    })
    const items = [item({}), item({ id: 'item-2', supplier_invoice_id: 'inv-2', payee_type: 'plusgiro', payee_bankgiro: null, payee_plusgiro: '1234566', reference_type: 'invoice_number', reference: 'F-118', amount: 100 })]

    const first = renderSupplierPaymentBatchFile(batch, items)

    expect(first.content).toBe(renderSupplierPaymentBatchFile(batch, items).content)
    expect(first.contentType).toBe('text/plain; charset=iso-8859-1')
    expect(first.charset).toBe('iso-8859-1')
    expect(first.filename).toBe('betalfil_20260810_b0000000.txt')
    const lines = first.content.split('\r\n').filter((line) => line)
    expect(lines.map((line) => line.slice(0, 2))).toEqual(['11', '14', '54', '29'])
    expect(lines[0].slice(2, 18)).toBe('0009912346260811')
    expect(lines[1].slice(2, 37)).toBe('0050501055' + '55601234566'.padEnd(25, ' '))
    expect(lines[2].slice(2, 37)).toBe('0001234566' + 'F-118'.padEnd(25, ' '))
    expect(lines[3].slice(12, 32)).toBe('00000002' + '000000083750')
    // The bytes the bank takes: å, ö as one ISO 8859-1 byte each.
    const bytes = batchFileBytes(first)
    expect(bytes.length).toBe(first.content.length)
    expect(bytes.includes(0xc5)).toBe(true)
  })

  it('refuses to render an LB batch that has no sender bankgiro', () => {
    const batch = batchRow({ format: 'bg_lb' })
    expect(() => renderSupplierPaymentBatchFile(batch, [])).toThrow('bankgironummer')
  })

  it('re-renders a stored Danske Bank batch with the IBAN debit, MsgId unchanged', () => {
    // A batch created before the Danske rule: its snapshot carries the company
    // bankgiro, and the file it rendered then debited that bankgiro.
    const batch = batchRow({
      debtor_snapshot: {
        name: 'Testbolaget AB',
        org_number: '556677-8899',
        iban: 'SE7212000000012200111878',
        bic: 'DABASESX',
        bankgiro: '9912346',
        city: 'Stockholm',
      },
    })

    const file = renderSupplierPaymentBatchFile(batch, [storedBankgiroItem()])

    const debtorAccounts = file.content.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/g) ?? []
    expect(debtorAccounts).toHaveLength(1)
    expect(debtorAccounts[0]).toContain('<IBAN>SE7212000000012200111878</IBAN>')
    expect(debtorAccounts[0]).not.toContain('BGNR')
    expect(file.content).not.toContain('9912346')
    expect(file.content).toContain(`<MsgId>${batch.msg_id}</MsgId>`)
  })

  it('re-renders a stored batch of any other bank with the bankgiro debit it always had', () => {
    const batch = batchRow({
      debtor_snapshot: {
        name: 'Testbolaget AB',
        org_number: '556677-8899',
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESSXXX',
        bankgiro: '9912346',
        city: 'Stockholm',
      },
    })

    const file = renderSupplierPaymentBatchFile(batch, [storedBankgiroItem()])

    const debtorAccount = file.content.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/)![0]
    expect(debtorAccount).toContain('<Id>9912346</Id>')
    expect(debtorAccount).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
    // The BIC is written as stored.
    expect(file.content).toContain('<BIC>ESSESESSXXX</BIC>')
  })

  it('re-renders a Swedbank batch made before the ids existed exactly as it was first downloaded', () => {
    const debtor = {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      iban: 'SE3550000000054910000003',
      bic: 'SWEDSESS',
      bankgiro: '9912346',
      city: 'Stockholm',
    }
    const batch = batchRow({ debtor_snapshot: debtor })

    const file = renderSupplierPaymentBatchFile(batch, [storedBankgiroItem()])

    const initiator = file.content.match(/<InitgPty>[\s\S]*?<\/InitgPty>/)![0]
    expect(initiator).toContain('<Othr><Id>5566778899</Id></Othr>')
    expect(file.content).not.toContain('<Cd>BANK</Cd>')
    // The MIG 1.0 bankgiro debit it was created with.
    const debtorAccount = file.content.match(/<DbtrAcct>[\s\S]*?<\/DbtrAcct>/)![0]
    expect(debtorAccount).toContain('<SchmeNm><Prtry>BGNR</Prtry></SchmeNm>')
  })
})
