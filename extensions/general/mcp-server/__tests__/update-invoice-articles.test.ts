/**
 * gnubok_update_invoice article references (issue #1642).
 *
 * The update tool's full-replace items now accept article_id with the SAME
 * prefill + default-set VAT adoption guard as gnubok_create_invoice
 * (resolveInvoiceLineFromArticle): description, unit, unit_price and
 * revenue_account prefill from the article, explicit line values win, and the
 * article's stored (domestic) vat_rate is adopted only when it is in the
 * customer's DEFAULT rate set. Before this, buildInvoiceWriteData wrote
 * article_id/revenue_account as NULL on every full-replace update, silently
 * rebooking revenue from the article's override account to the VAT-derived
 * default. The invoice currency and customer are structural on an update, so
 * both come from the stored draft, never from the arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const updateInvoice = tools.find((t) => t.name === 'gnubok_update_invoice')!

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const ARTICLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    document_type: 'invoice',
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    customer_id: 'cust-1',
    total: 0,
    currency: 'SEK',
    customer: { name: 'Synthetic Kund AB' },
    ...overrides,
  }
}

const CUSTOMER = {
  id: 'cust-1',
  name: 'Synthetic Kund AB',
  customer_type: 'swedish_business',
  vat_number_validated: false,
  default_payment_terms: 30,
}

/** Synthetic VAT-validated EU business: reverse charge, single locked 0%. */
const EU_CUSTOMER = {
  id: 'cust-eu',
  name: 'Muster GmbH',
  customer_type: 'eu_business',
  vat_number_validated: true,
  default_payment_terms: 30,
}

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

beforeEach(() => {
  vi.clearAllMocks()
})

/** Queue order: invoices → customers → articles → current invoice_items → insert. */
function enqueueHappyPath(
  enqueue: (r: { data: unknown; error?: unknown }) => void,
  customer: Record<string, unknown>,
  articleRows: Array<Record<string, unknown>>,
  invoice: Record<string, unknown> = draftInvoice(),
) {
  enqueue({ data: invoice })
  enqueue({ data: customer })
  enqueue({ data: articleRows })
  enqueue({ data: [] }) // current invoice_items (old-vs-new preview)
  enqueue({ data: { id: 'op-1' } })
}

describe('gnubok_update_invoice: article_id on items', () => {
  it('exposes article_id and revenue_account in the items input schema', () => {
    const itemsSchema = (updateInvoice.inputSchema.properties as Record<string, { items: { properties: Record<string, unknown>; required: string[] } }>).items
    expect(itemsSchema.items.properties).toHaveProperty('article_id')
    expect(itemsSchema.items.properties).toHaveProperty('revenue_account')
    expect(itemsSchema.items.properties).toHaveProperty('line_type')
    // Article lines resolve description/unit/unit_price from the article.
    expect(itemsSchema.items.required).toEqual(['quantity'])
  })

  it('prefills description, unit, price, VAT and revenue account from the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, CUSTOMER, [ARTICLE])

    const result = (await updateInvoice.execute(
      {
        invoice_id: INVOICE_ID,
        items: [{ article_id: ARTICLE_ID, quantity: 3 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: {
        items: Array<Record<string, unknown>>
        changes: { items: Array<Record<string, unknown>> }
        total?: number
      }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.items[0]).toMatchObject({
      article_id: ARTICLE_ID,
      description: 'Konsulttimme',
      unit: 'tim',
      unit_price: 1200,
      vat_rate: 25,
      revenue_account: '3041',
      line_total: 3600,
    })
    expect(result.preview.total).toBe(4500)
    // The STAGED params (what the commit executor writes) carry the article
    // linkage too: that is the silent-data-loss fix.
    expect(result.preview.changes.items[0]).toMatchObject({
      article_id: ARTICLE_ID,
      revenue_account: '3041',
      vat_rate: 25,
      unit_price: 1200,
    })
  })

  it('lets explicit line values win over the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, CUSTOMER, [ARTICLE])

    const result = (await updateInvoice.execute(
      {
        invoice_id: INVOICE_ID,
        items: [{ article_id: ARTICLE_ID, quantity: 1, description: 'Rabatterad timme', unit_price: 800 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { items: Array<Record<string, unknown>>; total?: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.items[0]).toMatchObject({
      description: 'Rabatterad timme',
      unit_price: 800,
      unit: 'tim',
      vat_rate: 25,
    })
    expect(result.preview.total).toBe(1000)
  })

  it('does NOT adopt the article domestic rate for a reverse-charge EU customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(
      enqueue,
      EU_CUSTOMER,
      [ARTICLE],
      draftInvoice({ customer_id: 'cust-eu', customer: { name: 'Muster GmbH' } }),
    )

    const result = (await updateInvoice.execute(
      {
        invoice_id: INVOICE_ID,
        items: [{ article_id: ARTICLE_ID, quantity: 10 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      preview: { items: Array<Record<string, unknown>>; total?: number; vat_amount?: number; vat_treatment?: string }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.items[0]).toMatchObject({ vat_rate: 0, unit_price: 1200 })
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(12000)
    expect(result.preview.vat_treatment).toBe('reverse_charge')
  })

  it('refuses an article_id that does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [] }) // articles fetch: no company-scoped hit

    await expect(
      updateInvoice.execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ article_id: ARTICLE_ID, quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found in this company/)
  })

  it('refuses a deactivated article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [{ ...ARTICLE, active: false }] })

    await expect(
      updateInvoice.execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ article_id: ARTICLE_ID, quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/deactivated/)
  })

  it('refuses a price prefill when the article is priced in another currency than the draft', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() }) // SEK draft
    enqueue({ data: CUSTOMER })
    enqueue({ data: [{ ...ARTICLE, currency: 'EUR' }] })

    await expect(
      updateInvoice.execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ article_id: ARTICLE_ID, quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/priced in EUR/)
  })

  it('still requires description, unit and unit_price on a line without article_id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      updateInvoice.execute(
        {
          invoice_id: INVOICE_ID,
          items: [{ quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/description is required/)
  })
})
