import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import {
  SetInboxPurchaseCategorySchema,
  setInboxItemPurchaseCategory,
  withPurchaseCategory,
} from '../inbox-purchase-category'

const mock = createQueuedMockSupabase()
const ITEM = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-15T09:30:00.000Z')
const ctx: OperationContext = {
  supabase: mock.supabase as unknown as SupabaseClient,
  companyId: 'company-1',
  userId: 'user-1',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as OperationContext['log'],
}

const READING = {
  documentKind: 'receipt',
  merchantCategory: 'other',
  supplier: { name: 'Clas Ohlson AB' },
  invoice: { currency: 'SEK' },
  lineItems: [{ description: 'Okänd vara', lineTotal: 100 }],
  totals: { total: 125 },
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    extracted_data: READING,
    matched_supplier_id: null,
    created_supplier_invoice_id: null,
    updated_at: '2026-10-15T09:00:00.000Z',
    ...overrides,
  }
}

const writtenReading = () =>
  (mock.findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data

beforeEach(() => mock.reset())

describe('withPurchaseCategory', () => {
  it('sets the choice beside everything else on the reading', () => {
    expect(withPurchaseCategory(READING, 'expense.equipment.tools', NOW.toISOString(), 'dashboard')).toEqual({
      ...READING,
      purchaseCategory: { code: 'expense.equipment.tools', source: 'person', set_at: NOW.toISOString(), set_via: 'dashboard' },
    })
  })

  it('removes the key for null, and only the key', () => {
    const withChoice = { ...READING, purchaseCategory: { code: 'expense.equipment.hardware', source: 'person' } }
    expect(withPurchaseCategory(withChoice, null, NOW.toISOString(), 'api')).toEqual(READING)
  })
})

describe('SetInboxPurchaseCategorySchema', () => {
  it('takes a taxonomy code or null, nothing else', () => {
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: 'expense.software.saas' }).success).toBe(true)
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: null }).success).toBe(true)
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: 'software' }).success).toBe(false)
    expect(SetInboxPurchaseCategorySchema.safeParse({}).success).toBe(false)
  })
})

describe('setInboxItemPurchaseCategory', () => {
  it('404 for an id that is no UUID, without reading', async () => {
    const out = await setInboxItemPurchaseCategory(ctx, 'item-1', 'expense.equipment.hardware', { via: 'dashboard' })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    expect(mock.calls).toHaveLength(0)
  })

  it('404 for an item outside the company', async () => {
    mock.enqueue({ data: null })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    expect(mock.findCalls('invoice_inbox_items', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('409 INBOX_ITEM_EDIT_LOCKED once converted, writing nothing', async () => {
    mock.enqueue({ data: item({ created_supplier_invoice_id: 'si-1' }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })
    expect(out).toMatchObject({ ok: false, code: 'INBOX_ITEM_EDIT_LOCKED', details: { supplier_invoice_id: 'si-1' } })
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('409 INBOX_ITEM_NO_READING for an item without a reading of its own, writing nothing', async () => {
    mock.enqueue({ data: item({ extracted_data: null }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NO_READING' })
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('a dry run previews, naming the underlag by its reading, and writes nothing', async () => {
    mock.enqueue({ data: item() })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'api', dryRun: true })
    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: { inbox_item_id: ITEM, purchase_category_code: 'expense.equipment.hardware', supplier_name: 'Clas Ohlson AB' },
    })
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('a dry run names the invoice number when the reading has one, and leaves out what it lacks', async () => {
    mock.enqueue({ data: item({ extracted_data: { ...READING, supplier: { name: '  ' }, invoice: { invoiceNumber: ' F-1042 ' } } }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, null, { via: 'api', dryRun: true })
    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: { inbox_item_id: ITEM, purchase_category_code: null, invoice_number: 'F-1042' },
    })
  })

  it('stores the choice under optimistic concurrency and answers it as Ditt val', async () => {
    mock.enqueue({ data: item() })
    mock.enqueue({ data: { id: ITEM } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', now: NOW })
    expect(out).toEqual({
      ok: true,
      data: { id: ITEM, purchase_category: { code: 'expense.equipment.tools', source: 'person', level: 'Ditt val', version: 'pc-2026-10' } },
    })
    expect(writtenReading()).toEqual({
      ...READING,
      purchaseCategory: { code: 'expense.equipment.tools', source: 'person', set_at: NOW.toISOString(), set_via: 'dashboard' },
    })
    expect(mock.findCalls('invoice_inbox_items', 'eq')).toContainEqual(['updated_at', '2026-10-15T09:00:00.000Z'])
  })

  it('clearing answers the proposal again', async () => {
    mock.enqueue({
      data: item({
        extracted_data: { ...READING, merchantCategory: 'taxi', purchaseCategory: { code: 'expense.equipment.hardware', source: 'person' } },
      }),
    })
    mock.enqueue({ data: { id: ITEM } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, null, { via: 'dashboard' })
    expect(out).toMatchObject({ ok: true, data: { purchase_category: { code: 'expense.travel.taxi', source: 'merchant_category' } } })
    expect(writtenReading()).not.toHaveProperty('purchaseCategory')
  })

  it('409 INBOX_ITEM_EDIT_CONFLICT when the row moved under the write', async () => {
    mock.enqueue({ data: item() })
    mock.enqueue({ data: null })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_EDIT_CONFLICT' })
  })

  it('reports a failed read or write as UNKNOWN_ERROR', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })
    mock.reset()
    mock.enqueue({ data: item() })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.hardware', { via: 'dashboard' })).toMatchObject({
      ok: false,
      code: 'UNKNOWN_ERROR',
    })
  })
})

describe('setInboxItemPurchaseCategory with every_time ("varje gång")', () => {
  const SUPPLIER = '33333333-3333-4333-8333-333333333333'
  const supplierUpdate = () => mock.findCall('suppliers', 'update')?.[0]

  it('takes every_time as an optional boolean, so old callers are unchanged', () => {
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: 'expense.software.saas', every_time: true }).success).toBe(true)
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: null, every_time: false }).success).toBe(true)
    expect(SetInboxPurchaseCategorySchema.safeParse({ code: 'expense.software.saas', every_time: 'yes' }).success).toBe(false)
  })

  it('409 INBOX_ITEM_NO_SUPPLIER without a matched supplier, writing nothing', async () => {
    mock.enqueue({ data: item() })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', everyTime: true })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' })
    expect(supplierUpdate()).toBeUndefined()
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('stores the instruction on the matched supplier, then the choice on the item, and answers Ditt val', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: { id: SUPPLIER } }) // supplier instruction
    mock.enqueue({ data: { id: ITEM } }) // item choice
    mock.enqueue({ data: [{ id: SUPPLIER, default_expense_account: null, default_purchase_category: 'expense.equipment.tools' }] })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', everyTime: true, now: NOW })
    expect(out).toEqual({
      ok: true,
      data: { id: ITEM, purchase_category: { code: 'expense.equipment.tools', source: 'person', level: 'Ditt val', version: 'pc-2026-10' } },
    })
    expect(supplierUpdate()).toEqual({ default_purchase_category: 'expense.equipment.tools' })
    expect(mock.findCalls('suppliers', 'eq')).toEqual(expect.arrayContaining([['id', SUPPLIER], ['company_id', 'company-1']]))
    expect(writtenReading()).toMatchObject({ purchaseCategory: { code: 'expense.equipment.tools', source: 'person' } })
    const order = mock.calls.filter((c) => c.method === 'update').map((c) => c.table)
    expect(order).toEqual(['suppliers', 'invoice_inbox_items'])
  })

  it('with code null removes the instruction and the item\'s choice', async () => {
    mock.enqueue({
      data: item({ matched_supplier_id: SUPPLIER, extracted_data: { ...READING, purchaseCategory: { code: 'expense.equipment.hardware', source: 'person' } } }),
    })
    mock.enqueue({ data: { id: SUPPLIER } })
    mock.enqueue({ data: { id: ITEM } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, null, { via: 'api', everyTime: true })
    expect(out.ok).toBe(true)
    expect(supplierUpdate()).toEqual({ default_purchase_category: null })
    expect(writtenReading()).not.toHaveProperty('purchaseCategory')
  })

  it('without every_time leaves the supplier alone', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: { id: ITEM } })
    await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', everyTime: false })
    expect(supplierUpdate()).toBeUndefined()
  })

  it('409 INBOX_ITEM_NO_SUPPLIER when the supplier write matches no row, before the item is touched', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: null })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', everyTime: true })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' })
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('reports a failed supplier write as UNKNOWN_ERROR, before the item is touched', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'dashboard', everyTime: true })
    expect(out).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('a dry run carries the underlag\'s document, so the proposal can show it', async () => {
    const DOCUMENT = '99999999-9999-4999-8999-999999999999'
    mock.enqueue({ data: item({ document_id: DOCUMENT }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'api', dryRun: true })
    expect(out).toMatchObject({ ok: true, dryRun: true, preview: { inbox_item_id: ITEM, document_id: DOCUMENT } })
  })

  it('a dry run names the supplier it would instruct, as the register has it, and writes nothing', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: { id: SUPPLIER, name: 'Clas Ohlson' } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'api', everyTime: true, dryRun: true })
    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: ITEM,
        purchase_category_code: 'expense.equipment.tools',
        supplier_name: 'Clas Ohlson AB',
        every_time: true,
        supplier_id: SUPPLIER,
        matched_supplier_name: 'Clas Ohlson',
      },
    })
    expect(mock.findCalls('suppliers', 'eq')).toEqual(expect.arrayContaining([['id', SUPPLIER], ['company_id', 'company-1']]))
    expect(supplierUpdate()).toBeUndefined()
  })

  it('a dry run refuses INBOX_ITEM_NO_SUPPLIER when the matched supplier is gone from the register', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: null })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', { via: 'api', everyTime: true, dryRun: true })
    expect(out).toEqual({ ok: false, code: 'INBOX_ITEM_NO_SUPPLIER' })
  })
})

describe('setInboxItemPurchaseCategory with a pinned supplier (expectedSupplierId)', () => {
  const SUPPLIER = '33333333-3333-4333-8333-333333333333'
  const OTHER = '44444444-4444-4444-8444-444444444444'

  it('writes the instruction and the choice while the item is still matched to it', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: SUPPLIER }) })
    mock.enqueue({ data: { id: SUPPLIER } })
    mock.enqueue({ data: { id: ITEM } })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', {
      via: 'approval',
      everyTime: true,
      expectedSupplierId: SUPPLIER,
      now: NOW,
    })
    expect(out.ok).toBe(true)
    expect(mock.findCall('suppliers', 'update')?.[0]).toEqual({ default_purchase_category: 'expense.equipment.tools' })
    expect(writtenReading()).toMatchObject({ purchaseCategory: { code: 'expense.equipment.tools', set_via: 'approval' } })
  })

  it('409 INBOX_ITEM_SUPPLIER_CHANGED when the item has been matched to another supplier, writing nothing', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: OTHER }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', {
      via: 'approval',
      everyTime: true,
      expectedSupplierId: SUPPLIER,
    })
    expect(out).toEqual({
      ok: false,
      code: 'INBOX_ITEM_SUPPLIER_CHANGED',
      details: { expected_supplier_id: SUPPLIER, matched_supplier_id: OTHER },
    })
    expect(mock.findCall('suppliers', 'update')).toBeUndefined()
    expect(mock.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('409 INBOX_ITEM_SUPPLIER_CHANGED when the item lost its supplier, writing nothing', async () => {
    mock.enqueue({ data: item({ matched_supplier_id: null }) })
    const out = await setInboxItemPurchaseCategory(ctx, ITEM, 'expense.equipment.tools', {
      via: 'approval',
      everyTime: true,
      expectedSupplierId: SUPPLIER,
    })
    expect(out).toMatchObject({ ok: false, code: 'INBOX_ITEM_SUPPLIER_CHANGED' })
    expect(mock.calls.filter((c) => c.method === 'update')).toEqual([])
  })
})
