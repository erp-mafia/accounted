/**
 * The purchase category over MCP: computed on the inbox reads
 * (gnubok_list_inbox_items, gnubok_get_inbox_item), the taxonomy behind it
 * (gnubok_list_purchase_categories, search-only) and the staged write that
 * proposes one (gnubok_set_inbox_purchase_category, search-only).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { PURCHASE_CATEGORY_CODES, PURCHASE_CATEGORY_GROUPS } from '@/lib/categories/purchase-categories'
import { deriveToolMeta, isDefaultCatalogTool, tools } from '../server'

const listTool = tools.find((t) => t.name === 'gnubok_list_inbox_items')!
const getTool = tools.find((t) => t.name === 'gnubok_get_inbox_item')!
const taxonomyTool = tools.find((t) => t.name === 'gnubok_list_purchase_categories')!
const setReadingTool = tools.find((t) => t.name === 'gnubok_set_inbox_extracted_data')!
const setCategoryTool = tools.find((t) => t.name === 'gnubok_set_inbox_purchase_category')!

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  delete process.env.RESEND_INBOUND_DOMAIN
})

const TELIA_TEMPLATE = {
  counterparty_name: 'telia company',
  counterparty_aliases: [],
  debit_account: '6212',
  credit_account: '1930',
  line_pattern: null,
  occurrence_count: 8,
  corrections: 0,
  source: 'auto_learned',
}

function inboxRow(id: string, extracted: Record<string, unknown> | null) {
  return {
    id,
    status: 'received',
    source: 'email',
    created_at: '2026-10-01T12:00:00Z',
    extracted_data: extracted,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: null,
    email_subject: null,
    error_message: null,
    document_attachments: null,
  }
}

describe('gnubok_list_inbox_items purchase_category', () => {
  it('carries what each item bought, from history, a person or nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        inboxRow('telia', { supplier: { name: 'Telia Company AB' }, lineItems: [] }),
        inboxRow('chosen', {
          supplier: { name: null },
          purchaseCategory: { code: 'expense.education.training', source: 'person', set_at: '2026-10-02T08:00:00Z' },
        }),
        inboxRow('unread', null),
      ],
      error: null,
    })
    enqueue({ data: [TELIA_TEMPLATE], error: null })
    enqueue({ data: [], error: null })

    const result = (await listTool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      items: Array<{ id: string; purchase_category: unknown }>
    }
    expect(result.items.map((i) => [i.id, i.purchase_category])).toEqual([
      ['telia', { code: 'expense.telecom.mobile', source: 'counterparty', level: 'Stark', version: 'pc-2026-10' }],
      ['chosen', { code: 'expense.education.training', source: 'person', level: 'Ditt val', version: 'pc-2026-10' }],
      ['unread', null],
    ])
  })
})

describe('gnubok_get_inbox_item purchase_category', () => {
  it('adds purchase_category to the item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: inboxRow('item-1', {
        documentKind: 'receipt',
        merchantCategory: 'parking',
        supplier: { name: 'Aimo Park' },
        lineItems: [],
      }),
      error: null,
    })
    const result = (await getTool.execute({ inbox_item_id: 'item-1' }, 'company-1', 'user-1', supabase as never)) as {
      id: string
      purchase_category: unknown
    }
    expect(result.id).toBe('item-1')
    expect(result.purchase_category).toEqual({
      code: 'expense.vehicle.parking',
      source: 'merchant_category',
      level: 'Trolig',
      version: 'pc-2026-10',
    })
  })
})

describe('gnubok_list_purchase_categories', () => {
  it('is a search-only read gated like the inbox reads', () => {
    expect(taxonomyTool.annotations.readOnlyHint).toBe(true)
    expect(taxonomyTool.catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_list_purchase_categories).toBe(TOOL_SCOPE_MAP.gnubok_list_inbox_items)
  })

  it('lists every code with Swedish and English names and its BAS accounts', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = (await taxonomyTool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      version: string
      country: string
      groups: Array<{ group: string; name: string; name_en: string; categories: Array<{ code: string; name: string; name_en: string; accounts: string[] }> }>
    }
    expect(result.version).toBe('pc-2026-10')
    expect(result.country).toBe('SE')
    expect(result.groups.map((g) => g.group)).toEqual([...PURCHASE_CATEGORY_GROUPS])
    const all = result.groups.flatMap((g) => g.categories)
    expect(all.map((c) => c.code)).toEqual([...PURCHASE_CATEGORY_CODES])
    const saas = all.find((c) => c.code === 'expense.software.saas')!
    expect(saas).toEqual({
      code: 'expense.software.saas',
      name: 'Programvaruabonnemang (SaaS)',
      name_en: 'Software subscriptions (SaaS)',
      accounts: ['5420', '6540'],
    })
    for (const c of all) {
      expect(c.name).not.toBe(c.code)
      expect(c.accounts.length).toBeGreaterThan(0)
    }
    expect(JSON.stringify(result).length).toBeLessThan(12_000)
  })

  it('narrows to one group', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = (await taxonomyTool.execute({ group: 'expense.travel' }, 'company-1', 'user-1', supabase as never)) as {
      groups: Array<{ group: string; name: string; name_en: string; categories: Array<{ code: string }> }>
    }
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ group: 'expense.travel', name: 'Resor', name_en: 'Travel' })
    expect(result.groups[0].categories.map((c) => c.code)).toContain('expense.travel.meals')
  })
})

describe('gnubok_set_inbox_extracted_data keeps a person\'s purchase category', () => {
  const agentReading = {
    supplier: { name: 'Anthropic Inc.', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
    invoice: { invoiceNumber: 'A-1', invoiceDate: '2026-10-01', dueDate: null, paymentReference: null, currency: 'USD' },
    lineItems: [],
    totals: { subtotal: 50, vatAmount: 0, total: 50 },
    vatBreakdown: [],
  }
  const choice = { code: 'expense.software.saas', source: 'person', set_at: '2026-10-02T08:00:00Z', set_via: 'dashboard' }

  it('carries the choice over the agent\'s full replacement, even when the agent sends one of its own', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'inbox-1', company_id: 'company-1', created_supplier_invoice_id: null, extracted_data: { purchaseCategory: choice } },
      error: null,
    })
    enqueue({ data: null, error: null }) // supplier match by name: none
    enqueue({ data: null, error: null }) // update

    const result = (await setReadingTool.execute(
      { inbox_item_id: 'inbox-1', extracted_data: { ...agentReading, purchaseCategory: { code: 'expense.equipment.hardware', source: 'person' } } },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as { extracted_data: Record<string, unknown> }

    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('extracted_data')
    const written = (findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    expect(written.purchaseCategory).toEqual(choice)
    expect(written.totals).toEqual(agentReading.totals)
    expect(result.extracted_data.purchaseCategory).toEqual(choice)
  })
})

describe('gnubok_set_inbox_purchase_category', () => {
  const ITEM = '22222222-2222-4222-8222-222222222222'
  const SUPPLIER = '33333333-3333-4333-8333-333333333333'
  const reading = { supplier: { name: 'Telia Company AB' }, invoice: { invoiceNumber: 'T-881' }, lineItems: [] }
  const itemRow = (overrides: Record<string, unknown> = {}) => ({
    id: ITEM,
    extracted_data: reading,
    matched_supplier_id: SUPPLIER,
    created_supplier_invoice_id: null,
    updated_at: '2026-10-16T08:00:00.000Z',
    ...overrides,
  })

  it('is a search-only staging write gated by documents:write', () => {
    expect(setCategoryTool).toBeDefined()
    expect(setCategoryTool.catalogVisibility).toBe('search')
    expect(isDefaultCatalogTool(setCategoryTool)).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_set_inbox_purchase_category).toBe('documents:write')
    expect(deriveToolMeta(setCategoryTool)).toMatchObject({ requires_approval: true, approve_tool: 'gnubok_approve_pending_operation' })
    expect(setCategoryTool.description.length).toBeLessThanOrEqual(280)
    expect(setCategoryTool.description).toMatch(/^Stage /)
    const schema = setCategoryTool.inputSchema as { required?: string[]; additionalProperties?: boolean }
    expect(schema.required).toEqual(expect.arrayContaining(['inbox_item_id', 'code']))
    expect(schema.additionalProperties).toBe(false)
  })

  it('stages the choice as set_inbox_purchase_category, pinning the supplier, and writes nothing else', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: itemRow() }) // the dry run reads the item
    enqueue({ data: { id: SUPPLIER, name: 'Telia' } }) // and the supplier it would instruct
    enqueue({ data: { id: 'op-1' } }) // pending_operations insert

    const result = (await setCategoryTool.execute(
      { inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key', id: 'key-1', label: 'Claude' },
    )) as { staged: boolean; operation_id: string; risk_level: string; preview: Record<string, unknown> }

    expect(result).toMatchObject({ staged: true, operation_id: 'op-1', risk_level: 'low' })
    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      operation_type: 'set_inbox_purchase_category',
      title: 'Ändra kategori för underlag från Telia Company AB, varje gång',
      // The approval writes to the supplier the card names, or nothing.
      params: { inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true, expected_supplier_id: SUPPLIER },
      preview_data: {
        inbox_item_id: ITEM,
        purchase_category_code: 'expense.telecom.mobile',
        supplier_name: 'Telia Company AB',
        invoice_number: 'T-881',
        every_time: true,
        supplier_id: SUPPLIER,
        matched_supplier_name: 'Telia',
      },
      risk_level: 'low',
      actor_type: 'api_key',
    })
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('stages clearing a choice (code null) for this item only', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: itemRow({ matched_supplier_id: null }) })
    enqueue({ data: { id: 'op-2' } })

    await setCategoryTool.execute({ inbox_item_id: ITEM, code: null }, 'company-1', 'user-1', supabase as never)

    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      title: 'Ta bort vald kategori för underlag från Telia Company AB',
      params: { inbox_item_id: ITEM, code: null },
    })
  })

  it('refuses at staging what could never commit, and stages nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: itemRow({ matched_supplier_id: null }) })

    await expect(
      setCategoryTool.execute({ inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INBOX_ITEM_NO_SUPPLIER' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a code outside the taxonomy before reading anything', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    await expect(
      setCategoryTool.execute({ inbox_item_id: ITEM, code: 'software' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(findCall('invoice_inbox_items', 'select')).toBeUndefined()
  })
})
