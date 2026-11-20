import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  directorySupplierDefault,
  preselectedSupplierTypeForCountry,
  rcBasisSupplierDefaults,
  supplierCardDefault,
} from '../rc-basis-supplier-default'
import { coerceSupplyType, rcGapClassification } from '../rc-basis-gap-classification'

// Where Korrigera starts the supplier type of an FK004 row (crm#1431): a
// service from another EU country is ruta 21 (4535), from outside the EU
// ruta 22 (4531), ML 6 kap. 34 §. Unknown starts on nothing.

describe('preselectedSupplierTypeForCountry', () => {
  it.each([
    ['US', 'non_eu_business'],
    ['GB', 'non_eu_business'],
    ['NO', 'non_eu_business'],
    ['IE', 'eu_business'],
    ['DE', 'eu_business'],
    ['EL', 'eu_business'],
    ['ie', 'eu_business'],
  ])('%s starts on %s', (country, type) => {
    expect(preselectedSupplierTypeForCountry(country)).toBe(type)
  })

  it.each([['SE'], ['Sverige'], [null], [''], ['not a country']])(
    'starts on nothing for %s (Sweden is asked, unknown is asked)',
    (country) => {
      expect(preselectedSupplierTypeForCountry(country)).toBeNull()
    },
  )
})

describe('supplierCardDefault', () => {
  it('reads the card country first', () => {
    expect(supplierCardDefault({ country: 'US', vat_number: null, supplier_type: 'non_eu_business' })).toEqual({
      supplierType: 'non_eu_business',
      country: 'US',
      source: 'supplier_card',
    })
    expect(supplierCardDefault({ country: 'IE', vat_number: 'IE9999999WH', supplier_type: 'eu_business' })).toEqual({
      supplierType: 'eu_business',
      country: 'IE',
      source: 'supplier_card',
    })
  })

  it('reads the VAT number prefix when the card has no country', () => {
    expect(supplierCardDefault({ country: null, vat_number: 'DE123456789', supplier_type: 'swedish_business' })).toEqual({
      supplierType: 'eu_business',
      country: 'DE',
      source: 'supplier_card',
    })
  })

  it('reads a chosen supplier type when the card names no country', () => {
    expect(supplierCardDefault({ country: null, vat_number: null, supplier_type: 'non_eu_business' })).toEqual({
      supplierType: 'non_eu_business',
      country: null,
      source: 'supplier_card',
    })
  })

  it('says nothing for the default supplier type alone, a Swedish card, or a card that contradicts itself', () => {
    expect(supplierCardDefault({ country: null, vat_number: null, supplier_type: 'swedish_business' })).toBeNull()
    expect(supplierCardDefault({ country: 'SE', vat_number: 'SE556677889901', supplier_type: 'swedish_business' })).toBeNull()
    expect(supplierCardDefault({ country: 'SE', vat_number: null, supplier_type: 'non_eu_business' })).toBeNull()
    expect(supplierCardDefault({ country: 'US', vat_number: null, supplier_type: 'eu_business' })).toBeNull()
    expect(supplierCardDefault(null)).toBeNull()
  })
})

describe('directorySupplierDefault', () => {
  it.each(['GitHub, Inc. · INV100000001', 'GITHUB, INC.', 'PAYPAL *GITHUB INC', 'Rättelse: GitHub, Inc.'])(
    'starts a GitHub purchase, billed from the US, outside the EU: %s (crm#1431)',
    (text) => {
      expect(directorySupplierDefault([text])).toEqual({ supplierType: 'non_eu_business', country: 'US', source: 'directory' })
    },
  )

  it('starts an Adobe purchase, billed from Ireland, on EU', () => {
    expect(directorySupplierDefault(['ADOBE SYSTEMS SOFTWARE'])).toEqual({
      supplierType: 'eu_business',
      country: 'IE',
      source: 'directory',
    })
  })

  it.each(['OpenAI dec 25', 'ANTHROPIC CLAUDE', 'VERCEL INC'])(
    'starts nothing for a vendor whose box waits on crm#1028 (catalog and directory disagree): %s',
    (text) => {
      expect(directorySupplierDefault([text])).toBeNull()
    },
  )

  it('starts nothing for a Swedish merchant, a payment rail alone, or a text it does not know', () => {
    expect(directorySupplierDefault(['LOVABLE'])).toBeNull()
    expect(directorySupplierDefault(['KLARNA'])).toBeNull()
    expect(directorySupplierDefault(['Konsultarvode okt'])).toBeNull()
    expect(directorySupplierDefault([null, undefined, ''])).toBeNull()
  })

  it('reads the texts in order: the bank row merchant before the voucher description', () => {
    expect(directorySupplierDefault(['GITHUB', 'Adobe licens'])?.country).toBe('US')
    expect(directorySupplierDefault([null, 'Kortköp', 'Adobe licens'])?.country).toBe('IE')
  })
})

describe('rcBasisSupplierDefaults', () => {
  it('reads the bank row, the supplier card and the description of each verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'e-bank', description: 'Kortköp', source_type: 'bank_transaction', source_id: 'tx-1' },
        { id: 'e-card', description: 'Leverantörsfaktura 12', source_type: 'supplier_invoice_registered', source_id: 'si-1' },
        { id: 'e-import', description: 'Adobe jan', source_type: 'import', source_id: null },
        { id: 'e-unknown', description: 'Verifikat 9', source_type: 'manual', source_id: null },
      ],
    })
    enqueue({ data: [{ id: 'tx-1', merchant_name: 'GITHUB, INC.', description: 'KORTKOP', original_description: null }] })
    enqueue({ data: [{ id: 'si-1', supplier: { country: 'NL', vat_number: null, supplier_type: 'eu_business' } }] })

    const defaults = await rcBasisSupplierDefaults(supabase as never, 'company-1', ['e-bank', 'e-card', 'e-import', 'e-unknown', 'e-bank'])

    expect(Object.fromEntries(defaults)).toEqual({
      'e-bank': { supplierType: 'non_eu_business', country: 'US', source: 'directory' },
      'e-card': { supplierType: 'eu_business', country: 'NL', source: 'supplier_card' },
      'e-import': { supplierType: 'eu_business', country: 'IE', source: 'directory' },
    })
    // Every read is scoped to the company.
    for (const table of ['journal_entries', 'transactions', 'supplier_invoices']) {
      expect(findCalls(table, 'eq')).toContainEqual(['company_id', 'company-1'])
    }
  })

  it('reads nothing for an empty list', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    expect((await rcBasisSupplierDefaults(supabase as never, 'company-1', [])).size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('throws a failed read to the caller, which starts every picker empty', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'boom' } })
    await expect(rcBasisSupplierDefaults(supabase as never, 'company-1', ['e-1'])).rejects.toEqual({ message: 'boom' })
  })
})

describe('rcGapClassification', () => {
  const shared = { supplierType: null, supplyType: 'service' } as const

  it('starts a row on its preselected supplier type, never on a silent EU default', () => {
    expect(rcGapClassification(undefined, 'non_eu_business', shared)).toEqual({ supplierType: 'non_eu_business', supplyType: 'service' })
    expect(rcGapClassification(undefined, 'eu_business', shared)).toEqual({ supplierType: 'eu_business', supplyType: 'service' })
    expect(rcGapClassification(undefined, null, shared)).toEqual({ supplierType: null, supplyType: 'service' })
  })

  it('lets the toolbar choice classify rows without a preselection, and the row choice win over both', () => {
    const toolbar = { supplierType: 'swedish_business', supplyType: 'goods' } as const
    expect(rcGapClassification(undefined, null, toolbar)).toEqual(toolbar)
    expect(rcGapClassification(undefined, 'eu_business', toolbar)).toEqual({ supplierType: 'eu_business', supplyType: 'goods' })
    const own = { supplierType: 'eu_business', supplyType: 'service' } as const
    expect(rcGapClassification(own, 'non_eu_business', toolbar)).toEqual(own)
  })

  it('keeps taking the supplier type from elsewhere when the row only chose its supply type', () => {
    const goodsOnly = { supplierType: null, supplyType: 'goods' } as const
    expect(rcGapClassification(goodsOnly, null, shared)).toEqual({ supplierType: null, supplyType: 'goods' })
    expect(rcGapClassification(goodsOnly, 'eu_business', shared)).toEqual({ supplierType: 'eu_business', supplyType: 'goods' })
    expect(rcGapClassification(goodsOnly, null, { supplierType: 'swedish_business', supplyType: 'service' })).toEqual({
      supplierType: 'swedish_business',
      supplyType: 'goods',
    })
  })

  it('keeps goods off a supplier outside the EU: that is import VAT, not reverse charge', () => {
    expect(rcGapClassification(undefined, 'non_eu_business', { supplierType: null, supplyType: 'goods' })).toEqual({
      supplierType: 'non_eu_business',
      supplyType: 'service',
    })
    expect(coerceSupplyType('eu_business', 'goods')).toBe('goods')
  })
})
