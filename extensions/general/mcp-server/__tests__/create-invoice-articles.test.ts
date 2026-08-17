/**
 * gnubok_create_invoice article references (artikelregister).
 *
 * A line may set article_id (from gnubok_list_articles): staging prefills
 * description, unit, unit_price, vat_rate and revenue_account from the
 * article, with the same explicit-wins semantics as the web line picker
 * (InvoiceEditor). Unknown, foreign-company and deactivated articles are
 * refused at staging; a price prefill from an article in another currency is
 * refused rather than silently misread as the invoice currency.
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

describe('gnubok_create_invoice: article_id on items', () => {
  it('prefills description, unit, price, VAT and revenue account from the article', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [ARTICLE], error: null }) // articles fetch
    enqueue({ data: CUSTOMER, error: null }) // customers fetch
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

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
    enqueue({ data: [ARTICLE], error: null })
    enqueue({ data: CUSTOMER, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-2' }, error: null })

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

  it('refuses an article_id that does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
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
    enqueue({ data: [{ ...ARTICLE, currency: 'EUR' }], error: null })
    enqueue({ data: CUSTOMER, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-3' }, error: null })

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
    const { supabase } = createQueuedMockSupabase()

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
