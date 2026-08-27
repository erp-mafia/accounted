import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  createSupplierPaymentBatch,
  previewSupplierPaymentBatch,
  renderSupplierPaymentBatchFile,
} from '@/lib/payments/batch-service'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'

const COMPANY_ID = 'c0000000-0000-0000-0000-000000000001'
const USER_ID = 'u0000000-0000-0000-0000-000000000001'

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
  it('creates a batch through the atomic RPC with snapshotted payee rows and a derived msg_id', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
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
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
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
      { data: { ok: false, code: 'ineligible', details: [{ id: 'inv-1', reason: 'not_payable' }] } },
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: { ok: false, code: 'amount_exceeds_remaining', details: [{ id: 'inv-1' }] } },
    ])
    const input = { format: 'pain001' as const, items: [{ supplier_invoice_id: 'inv-1' }] }

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

  it('maps an RPC error (constraint violation, guard) to create_failed', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { error: { message: 'payee_fields_match', code: '23514' } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'create_failed' })
  })

  it('maps an unknown RPC refusal code and an empty RPC payload to create_failed', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: { ok: false, code: 'something_new' } },
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: null },
    ])
    const input = { format: 'pain001' as const, items: [{ supplier_invoice_id: 'inv-1' }] }

    const unknown = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(unknown).toEqual({ ok: false, code: 'create_failed' })

    const empty = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      input,
    )
    expect(empty).toEqual({ ok: false, code: 'create_failed' })
  })

  it('rejects the whole batch when any invoice is ineligible', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow(), invoiceRow({ id: 'inv-2', currency: 'EUR' })] },
      { data: [] },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      {
        format: 'pain001',
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

  it('rejects an amount override above the remaining amount', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1', amount: 800 }] },
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
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
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
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      {
        format: 'pain001',
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
        format: 'pain001',
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
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
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
      { data: { ok: true, batch: batchRow() } },
    ])

    const result = await createSupplierPaymentBatch(
      mock.supabase as unknown as SupabaseClient,
      COMPANY_ID,
      USER_ID,
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
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
      { format: 'pain001', items: [{ supplier_invoice_id: 'inv-1' }] },
    )

    expect(result).toEqual({ ok: false, code: 'debtor_incomplete', missing: 'org_number' })
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})

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
    expect(() => renderSupplierPaymentBatchFile(batchRow({ format: 'bg_lb' }), [])).toThrow()
  })
})
