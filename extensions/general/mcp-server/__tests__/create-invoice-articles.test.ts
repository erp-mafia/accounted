/**
 * gnubok_create_invoice article references (artikelregister).
 *
 * A line may set article_id (from gnubok_list_articles): staging prefills
 * description, unit, unit_price and revenue_account from the article, with the
 * same explicit-wins semantics as the web line picker (InvoiceEditor's
 * applyArticle). The article's stored vat_rate is its DOMESTIC rate and is
 * adopted only when it is in the customer's DEFAULT rate set: a foreign
 * business locked to 0% reverse charge / export must NOT inherit 25% from the
 * article, because the permitted-set gate (widened for taxed-where-performed
 * supplies) would let it through and book Swedish VAT onto a reverse-charge
 * invoice. Unknown, foreign-company and deactivated articles are refused at
 * staging; a price prefill from an article in another currency is refused
 * rather than silently misread as the invoice currency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

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

/** Synthetic non-EU business: export, single locked 0%. */
const EXPORT_CUSTOMER = {
  id: 'cust-export',
  name: 'Overseas Inc',
  customer_type: 'non_eu_business',
  vat_number_validated: false,
  default_payment_terms: 30,
}

const ARTICLE = {
  id: 'art-1',
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

/** Queue order: customers → articles → period layers ×2 → pending_operations insert. */
function enqueueHappyPath(
  enqueue: (r: { data: unknown; error: unknown }) => void,
  customer: Record<string, unknown>,
  articleRows: Array<Record<string, unknown>>,
) {
  enqueue({ data: customer, error: null })
  enqueue({ data: articleRows, error: null })
  enqueue({ data: null, error: null })
  enqueue({ data: null, error: null })
  enqueue({ data: { id: 'op-1' }, error: null })
}

describe('gnubok_create_invoice: article_id on items', () => {
  it('prefills description, unit, price, VAT and revenue account from the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, CUSTOMER, [ARTICLE])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 3 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { items: Array<Record<string, unknown>>; total?: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.items[0]).toMatchObject({
      article_id: 'art-1',
      description: 'Konsulttimme',
      unit: 'tim',
      unit_price: 1200,
      vat_rate: 25,
      revenue_account: '3041',
      line_total: 3600,
    })
    expect(result.preview.total).toBe(4500)
  })

  it('lets explicit line values win over the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, CUSTOMER, [ARTICLE])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 1, description: 'Rabatterad timme', unit_price: 800 }],
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
    // The skeptic counterexample: {article_id, quantity} to a VIES-validated
    // German GmbH. The article's 25% is in the PERMITTED set (taxed-where-
    // performed widening) so a naive prefill would sail through the gate and
    // book Swedish VAT onto a reverse-charge invoice. The default set for this
    // customer is a single locked 0%, so the article rate must not be adopted.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, EU_CUSTOMER, [ARTICLE])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 10 }],
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

  it('does NOT adopt the article domestic rate for an export customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, EXPORT_CUSTOMER, [ARTICLE])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-export',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 2 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { vat_amount?: number; total?: number; vat_treatment?: string } }

    expect(result.staged).toBe(true)
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(2400)
    expect(result.preview.vat_treatment).toBe('export')
  })

  it('still honors an explicit line vat_rate for a foreign customer (taxed where performed)', async () => {
    // A Stockholm hotel night sold to a German company legitimately carries
    // 12%: the explicit-line escape hatch must survive the adoption guard.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, EU_CUSTOMER, [{ ...ARTICLE, name: 'Hotellnatt', vat_rate: 12, price_excl_vat: 1000 }])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 2, vat_rate: 12 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { total?: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.total).toBe(2240)
  })

  it('refuses an article_id that does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: CUSTOMER, error: null })
    enqueue({ data: [], error: null }) // articles fetch: no company-scoped hit

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          items: [{ article_id: 'art-other-company', quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found in this company/)
  })

  it('refuses a deactivated article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: CUSTOMER, error: null })
    enqueue({ data: [{ ...ARTICLE, active: false }], error: null })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          items: [{ article_id: 'art-1', quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/deactivated/)
  })

  it('refuses a price prefill when the article is priced in another currency', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: CUSTOMER, error: null })
    enqueue({ data: [{ ...ARTICLE, currency: 'EUR' }], error: null })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          items: [{ article_id: 'art-1', quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/priced in EUR/)
  })

  it('accepts a foreign-currency article when the line sets unit_price explicitly', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueHappyPath(enqueue, CUSTOMER, [{ ...ARTICLE, currency: 'EUR' }])

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        invoice_date: '2026-05-12',
        items: [{ article_id: 'art-1', quantity: 1, unit_price: 950 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { total?: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.total).toBe(1187.5)
  })

  it('still requires description, unit and unit_price on a line without article_id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: CUSTOMER, error: null })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          items: [{ quantity: 1 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/description is required/)
  })
})
