import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const ARTICLE_ID = '44444444-4444-4444-8444-444444444444'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_update_invoice')!

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    document_type: 'invoice',
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    total: 12500,
    currency: 'SEK',
    customer_id: CUSTOMER_ID,
    customer: { name: 'Acme AB' },
    ...overrides,
  }
}

/** Only the VAT-rule columns the items branch selects. */
const CUSTOMER = { customer_type: 'swedish_business', vat_number_validated: false }
/** VIES-validated EU business: reverse charge, single locked 0%. */
const EU_CUSTOMER = { customer_type: 'eu_business', vat_number_validated: true }
/** Non-EU business: export, single locked 0%. */
const EXPORT_CUSTOMER = { customer_type: 'non_eu_business', vat_number_validated: false }

const ARTICLE = {
  id: ARTICLE_ID,
  name: 'Konsulttimme',
  unit: 'tim',
  price_excl_vat: 1200,
  vat_rate: 25,
  revenue_account: '3041',
  currency: 'SEK',
  active: true,
}

/** What the draft holds today: an article line booked to 3041 at 25%. */
const CURRENT_ROWS = [
  {
    line_type: 'product',
    description: 'Konsulttimme',
    quantity: 1,
    unit: 'tim',
    unit_price: 1200,
    line_total: 1200,
    vat_rate: 25,
    revenue_account: '3041',
    article_id: ARTICLE_ID,
  },
]

type StagedResult = {
  staged: boolean
  preview: Record<string, unknown> & {
    items?: Array<Record<string, unknown>>
    current_items?: Array<Record<string, unknown>>
    changes?: { items?: Array<Record<string, unknown>> }
  }
}

/** Queue order for an items edit: invoices, customers, [articles], invoice_items snapshot, pending_operations. */
function enqueueItemsEdit(
  enqueue: (r: { data: unknown; error?: unknown }) => void,
  customer: Record<string, unknown>,
  articleRows: Array<Record<string, unknown>> | null,
  currentRows: Array<Record<string, unknown>> = CURRENT_ROWS,
) {
  enqueue({ data: draftInvoice() })
  enqueue({ data: customer })
  if (articleRows) enqueue({ data: articleRows })
  enqueue({ data: currentRows })
  enqueue({ data: { id: 'op-invoice-2' } })
}

describe('gnubok_update_invoice: registration', () => {
  it('is a strict, staged invoices:write tool at medium risk', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.destructiveHint).toBe(false)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_update_invoice).toBe('invoices:write')
    expect(OPERATION_RISK_TIERS.update_invoice).toBe('medium')
  })

  it('returns the staged-operation envelope (staged completion signal)', () => {
    const schema = tool().outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema?.properties?.staged).toBeDefined()
    expect(schema?.required).toContain('staged')
  })

  it('keeps its description within the 280-char budget and declares staging', () => {
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).toMatch(/stag(e|ing)/i)
  })

  it('points the agent at the round-trip read tool and states the replace semantics', () => {
    expect(tool().description).toMatch(/FULL REPLACE/)
    expect(tool().description).toContain('gnubok_get_invoice')
    const items = (tool().inputSchema.properties as Record<string, { description?: string }>).items
    expect(items.description).toMatch(/FULL REPLACE/)
    expect(items.description).toContain('gnubok_get_invoice')
  })

  it('accepts article_id on a line with the same optional shape as gnubok_create_invoice', () => {
    const items = (tool().inputSchema.properties as Record<string, unknown>).items as {
      items: { properties: Record<string, unknown>; required: string[] }
    }
    expect(items.items.properties.article_id).toBeDefined()
    expect(items.items.required).toEqual(['quantity'])
    const create = tools.find((candidate) => candidate.name === 'gnubok_create_invoice')!
    const createItems = (create.inputSchema.properties as Record<string, unknown>).items as {
      items: { required: string[] }
    }
    expect(items.items.required).toEqual(createItems.items.required)
  })

  it('does not accept structural or server-controlled fields', () => {
    const properties = tool().inputSchema.properties as Record<string, unknown>
    for (const forbidden of ['customer_id', 'currency', 'document_type', 'invoice_number', 'status']) {
      expect(properties, `must not expose ${forbidden}`).not.toHaveProperty(forbidden)
    }
  })
})

describe('gnubok_update_invoice: validation and staging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute({ notes: 'x' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/invoice_id/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('requires at least one changed field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an empty items array (full-replace needs at least one line)', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/non-empty/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an item without a positive quantity before querying', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ description: 'Konsultation', quantity: 0, unit: 'tim', unit_price: 1000 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/quantity/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the invoice is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, notes: 'Ny anteckning' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it.each([
    ['sent invoice', { status: 'sent' }],
    ['paid invoice', { status: 'paid' }],
    ['draft with a posted verifikat', { journal_entry_id: 'je-1' }],
    ['self-billed draft', { is_self_billed: true }],
    ['credit-note draft', { credited_invoice_id: '33333333-3333-4333-8333-333333333333' }],
  ])('refuses a %s at staging time', async (_label, overrides) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice(overrides) })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, notes: 'Ny anteckning' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not an editable draft/i)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('refuses an items edit on a non-draft before touching customer or articles', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice({ status: 'sent' }) })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 1 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not an editable draft/i)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('returns a dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, due_date: '2026-08-31', dry_run: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      invoice_id: INVOICE_ID,
      customer_name: 'Acme AB',
      changes: { due_date: '2026-08-31' },
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('stages a header edit for approval with exactly one read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: { id: 'op-invoice-1' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, notes: 'Uppdaterad anteckning' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string; preview: Record<string, unknown> }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-invoice-1',
      risk_level: 'medium',
    })
    expect(supabase.from).toHaveBeenCalledTimes(2)
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
    // No line snapshot on a header-only edit: nothing is replaced.
    expect(result.preview.items).toBeUndefined()
    expect(result.preview.current_items).toBeUndefined()
  })

  it('stages a full item replace with the effective booking and the lines being replaced', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, CUSTOMER, null)

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [
          { description: 'Konsultation', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({
      invoice_id: INVOICE_ID,
      items_replace: true,
      item_count: 1,
      currency: 'SEK',
      subtotal: 2000,
      vat_amount: 500,
      total: 2500,
    })
    // The approver sees the per-line booking, not only a row count: a line
    // without an article books by VAT treatment (revenue_account null).
    expect(result.preview.items?.[0]).toEqual({
      description: 'Konsultation',
      quantity: 2,
      unit: 'tim',
      unit_price: 1000,
      line_total: 2000,
      vat_rate: 25,
      revenue_account: null,
      article_id: null,
    })
    // ... next to what the replace deletes (the 3041 article line).
    expect(result.preview.current_items).toEqual(CURRENT_ROWS)
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'invoices')
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'customers')
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'invoice_items')
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'pending_operations')
    expect(supabase.from).toHaveBeenCalledTimes(4)
  })

  it('applies the customer default VAT rate to a line that omits vat_rate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, CUSTOMER, null)

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.preview.items?.[0]).toMatchObject({ vat_rate: 25, line_total: 1000 })
    expect(result.preview.total).toBe(1250)
  })

  it('fails when the draft customer is gone (VAT rules cannot be resolved)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: null, error: { message: 'no rows' } })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ description: 'Rad', quantity: 1, unit: 'st', unit_price: 100 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/customer not found/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})

describe('gnubok_update_invoice: article_id on items (issue #1642)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefills description, unit, price, VAT and revenue account from the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, CUSTOMER, [ARTICLE])

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 2 }] },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.staged).toBe(true)
    const expected = {
      article_id: ARTICLE_ID,
      description: 'Konsulttimme',
      unit: 'tim',
      unit_price: 1200,
      vat_rate: 25,
      revenue_account: '3041',
    }
    // Both what the executor will write (params.changes.items) and what the
    // approver sees (preview.items) carry the article linkage: the quantity
    // fix no longer rebooks 3041 to the VAT-derived default.
    expect(result.preview.changes?.items?.[0]).toMatchObject(expected)
    expect(result.preview.items?.[0]).toMatchObject({ ...expected, quantity: 2, line_total: 2400 })
    expect(result.preview.total).toBe(3000)
    expect(supabase.from).toHaveBeenNthCalledWith(1, 'invoices')
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'customers')
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'articles')
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'invoice_items')
    expect(supabase.from).toHaveBeenNthCalledWith(5, 'pending_operations')
  })

  it('lets explicit line values win over the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, CUSTOMER, [ARTICLE])

    const result = (await tool().execute(
      {
        invoice_id: INVOICE_ID,
        items: [
          { article_id: ARTICLE_ID, quantity: 1, description: 'Rabatterad timme', unit_price: 800, revenue_account: '3051' },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.preview.items?.[0]).toMatchObject({
      description: 'Rabatterad timme',
      unit_price: 800,
      unit: 'tim',
      vat_rate: 25,
      revenue_account: '3051',
      article_id: ARTICLE_ID,
    })
    expect(result.preview.total).toBe(1000)
  })

  it('does NOT adopt the article domestic rate for a reverse-charge EU customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, EU_CUSTOMER, [ARTICLE])

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 10 }] },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.staged).toBe(true)
    expect(result.preview.items?.[0]).toMatchObject({ vat_rate: 0, unit_price: 1200, revenue_account: '3041' })
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(12000)
  })

  it('does NOT adopt the article domestic rate for an export customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueItemsEdit(enqueue, EXPORT_CUSTOMER, [ARTICLE])

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 2 }] },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.preview.items?.[0]).toMatchObject({ vat_rate: 0 })
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(2400)
  })

  it('gates the effective rate against the permitted set at staging, not at approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      tool().execute(
        {
          invoice_id: INVOICE_ID,
          // 19% is not a Swedish VAT rate for any customer type: the agent
          // gets the error here instead of a failed approval later.
          items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 19 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not allowed/)
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('refuses an article_id that does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [] }) // articles: no company-scoped hit

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 1 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/gnubok_list_articles/)
  })

  it('refuses a deactivated article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [{ ...ARTICLE, active: false }] })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 1 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/deactivated/)
  })

  it('refuses a price prefill from an article in another currency than the draft', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() }) // SEK draft
    enqueue({ data: CUSTOMER })
    enqueue({ data: [{ ...ARTICLE, currency: 'EUR', price_excl_vat: 100 }] })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ article_id: ARTICLE_ID, quantity: 1 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/priced in EUR but the invoice is in SEK/)
  })

  it('still requires description, unit and unit_price on a line without an article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      tool().execute(
        { invoice_id: INVOICE_ID, items: [{ quantity: 1, unit: 'st', unit_price: 100 }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/description is required/)
  })
})
