/**
 * gnubok_create_invoice VAT-rate gate.
 *
 * The tool validates every line's rate at STAGING time, so a gate that is too
 * narrow refuses the invoice before the executor (commitCreateInvoice) is ever
 * reached: the MCP surface was the last one that could not issue a lawful
 * taxed-where-performed invoice to a foreign business.
 *
 * Huvudregeln (ML 6 kap. 34 §) taxes a B2B service where the buyer is
 * established, so 0% reverse charge stays the DEFAULT for a VAT-validated EU
 * business. The ML 6 kap. exceptions taxed where the supply is performed
 * (hotel/restaurang 12%, persontransport and event admission 6%,
 * fastighetstjänst and korttidsuthyrning 25%) carry Swedish VAT even then.
 * Rates outside {0, 25, 12, 6} are not Swedish VAT rates at all and stay
 * refused for every customer type.
 *
 * The structural sibling of this file is lib/invoices/__tests__/
 * vat-rate-gate-parity.test.ts, which pins that all seven write paths call the
 * same getPermittedVatRates helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

/** Synthetic VAT-validated EU business: reverse charge is its default. */
const EU_CUSTOMER = {
  id: 'cust-eu',
  name: 'Muster GmbH',
  customer_type: 'eu_business',
  vat_number_validated: true,
  default_payment_terms: 30,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_create_invoice: VAT-rate gate for a foreign business', () => {
  it('accepts a 12% line to a VAT-validated EU business (hotel night in Sweden)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EU_CUSTOMER, error: null }) // customers fetch
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-hotel' }, error: null }) // pending_operations insert

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [
          { description: 'Hotellnatt Stockholm', quantity: 2, unit: 'st', unit_price: 1000, vat_rate: 12 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { total?: number } }

    expect(result.staged).toBe(true)
    // 2000 net + 240 moms: the Swedish rate actually reached the staged totals.
    expect(result.preview.total).toBe(2240)
  })

  it('still refuses a rate that is not a Swedish VAT rate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EU_CUSTOMER, error: null })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-eu',
          invoice_date: '2026-05-12',
          items: [
            { description: 'Konsultarvode', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 10 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/VAT rate 10% is not allowed/)
  })

  it('keeps 0% as the default when a line omits vat_rate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EU_CUSTOMER, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-consulting' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ description: 'Konsultarvode', quantity: 1, unit: 'tim', unit_price: 1000 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { total?: number; vat_amount?: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(1000)
  })
})

describe('gnubok_create_invoice: says why the VAT treatment is what it is (#2749, #2558)', () => {
  type StagedWithWarnings = {
    staged: boolean
    message: string
    preview: {
      vat_amount?: number
      vat_treatment?: string
      vat_warnings?: Array<{ code: string; message_sv: string; message_en: string }>
      compliance_warning?: string
    }
  }

  it('stages 25 % for an EU business without a validated number and names the failed condition', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { ...EU_CUSTOMER, vat_number: 'DE123456789', vat_number_validated: false, country: 'DE' },
      error: null,
    })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-unvalidated' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ description: 'Konsultarvode', quantity: 1, unit: 'tim', unit_price: 1000 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedWithWarnings

    // Never blocks: the rule gives Swedish VAT and the operation stages.
    expect(result.staged).toBe(true)
    expect(result.preview.vat_treatment).toBe('standard_25')
    expect(result.preview.vat_amount).toBe(250)
    // Structured for the approval card and the agent ...
    expect(result.preview.vat_warnings?.map((w) => w.code)).toEqual(['EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED'])
    // ... and in the message the agent reads, through the existing WARNING channel.
    expect(result.message).toMatch(/WARNING: EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED: Reverse charge is not applied/)
    expect(result.preview.compliance_warning).toContain('EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED')
  })

  it('warns, without blocking, about a Swedish rate to a VIES-validated EU business (#2558)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EU_CUSTOMER, vat_number: 'DE123456789', country: 'DE' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-hotel-warned' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ description: 'Hotellnatt Stockholm', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 12 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedWithWarnings

    expect(result.staged).toBe(true)
    expect(result.preview.vat_warnings?.map((w) => w.code)).toEqual(['SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER'])
    expect(result.preview.vat_warnings?.[0].message_sv).toContain('Svensk moms (12 %)')
  })

  it('stays silent on the normal reverse-charge case', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EU_CUSTOMER, vat_number: 'DE123456789', country: 'DE' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-clean' }, error: null })

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-eu',
        invoice_date: '2026-05-12',
        items: [{ description: 'Konsultarvode', quantity: 1, unit: 'tim', unit_price: 1000 }],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedWithWarnings

    expect(result.staged).toBe(true)
    expect(result.preview.vat_warnings).toBeUndefined()
    expect(result.message).not.toContain('WARNING')
  })
})
