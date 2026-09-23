import { describe, it, expect } from 'vitest'
import {
  buildInvoiceWritePayload,
  buildSelfBilledPayload,
  hasDimensionValues,
  pruneItemDimensions,
  sanitizeDeductionItems,
  stripSelfBillingFields,
} from '@/lib/invoices/editor-payload'

/**
 * Payload-parity ratchet for the invoice editor rebuild.
 *
 * The "legacy" builders below are verbatim re-implementations of the three
 * inline payload builders that lived in InvoiceEditor.tsx (handleConfirm,
 * saveDraftData, saveEdit) and the inline self-billed body mapper, before the
 * extraction into lib/invoices/editor-payload.ts. Every combination in the
 * matrix asserts JSON.stringify equality between the extracted builder and
 * the legacy recipe: what goes over the wire may not change by a byte.
 */

type Item = {
  line_type?: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate: number
  article_id?: string | null
  revenue_account?: string | null
  deduction_type?: 'rot' | 'rut' | null
  labor_hours?: number | null
  work_type?: string | null
  housing_designation?: string | null
  apartment_number?: string | null
  brf_org_number?: string | null
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
  dimensions?: Record<string, string> | null
}

type FormData = {
  customer_id: string
  invoice_date: string
  due_date: string
  delivery_date?: string
  currency: string
  document_type: 'invoice' | 'proforma' | 'delivery_note'
  your_reference?: string
  our_reference?: string
  notes?: string
  payment_link_url?: string
  payment_link_auto?: boolean
  external_invoice_number?: string
  self_billing_agreement_ref?: string
  received_date?: string
  deduction_personnummer?: string
  deduction_housing_designation?: string
  items: Item[]
}

// ---------------------------------------------------------------------------
// Legacy recipes (verbatim from InvoiceEditor.tsx before the extraction)
// ---------------------------------------------------------------------------

function legacyHasDimensionValues(dims: Record<string, string> | null | undefined): boolean {
  return !!dims && Object.keys(dims).length > 0
}

function legacyPruneItemDimensions<T extends { dimensions?: Record<string, string> | null }>(
  items: T[],
): T[] {
  return items.map((item) =>
    legacyHasDimensionValues(item.dimensions) ? item : { ...item, dimensions: undefined },
  )
}

function legacyStripSelfBillingFields(data: FormData): Omit<
  FormData,
  'external_invoice_number' | 'self_billing_agreement_ref' | 'received_date'
> {
  const {
    external_invoice_number: _ein,
    self_billing_agreement_ref: _sbar,
    received_date: _rd,
    ...rest
  } = data
  return rest
}

function legacySanitizedItems(items: Item[]) {
  return legacyPruneItemDimensions(items).map((item) => {
    if (item.deduction_type) return item
    const {
      deduction_type: _dt,
      labor_hours: _lh,
      work_type: _wt,
      housing_designation: _hd,
      apartment_number: _an,
      brf_org_number: _bn,
      ...rest
    } = item
    return rest
  })
}

/** handleConfirm's inline body (create with review). */
function legacyCreatePayload(
  data: FormData,
  oreRounding: boolean,
  defaultDims: Record<string, string>,
) {
  const anyDeduction = data.items.some((i) => i.deduction_type)
  return {
    ...legacyStripSelfBillingFields(data),
    ore_rounding: oreRounding,
    default_dimensions: defaultDims,
    items: legacySanitizedItems(data.items),
    ...(anyDeduction
      ? {}
      : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
  }
}

/** saveDraftData's inline body (create + save_as_draft). */
function legacyDraftPayload(
  data: FormData,
  oreRounding: boolean,
  defaultDims: Record<string, string>,
) {
  const anyDeduction = data.items.some((i) => i.deduction_type)
  return {
    ...legacyStripSelfBillingFields(data),
    save_as_draft: true,
    ore_rounding: oreRounding,
    default_dimensions: defaultDims,
    items: legacySanitizedItems(data.items),
    ...(anyDeduction
      ? {}
      : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
  }
}

/** saveEdit's inline body (PATCH). Identical recipe to create. */
const legacyEditPayload = legacyCreatePayload

/** handleSelfBilledSubmit's inline body. */
function legacySelfBilledPayload(data: FormData) {
  return {
    customer_id: data.customer_id,
    external_invoice_number: data.external_invoice_number,
    self_billing_agreement_ref: data.self_billing_agreement_ref || undefined,
    invoice_date: data.invoice_date,
    received_date: data.received_date,
    due_date: data.due_date,
    currency: data.currency,
    notes: data.notes,
    items: data.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unit_price: i.unit_price,
      vat_rate: i.vat_rate,
    })),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plainItem(overrides: Partial<Item> = {}): Item {
  return {
    line_type: 'product',
    description: 'Konsulttid',
    quantity: 10,
    unit: 'tim',
    unit_price: 1200,
    vat_rate: 25,
    article_id: null,
    revenue_account: null,
    deduction_type: null,
    labor_hours: null,
    work_type: null,
    housing_designation: null,
    apartment_number: null,
    brf_org_number: null,
    accrual_period_start: null,
    accrual_period_end: null,
    accrual_balance_account: null,
    dimensions: null,
    ...overrides,
  }
}

function rotItem(overrides: Partial<Item> = {}): Item {
  return plainItem({
    description: 'Målning av fasad',
    deduction_type: 'rot',
    labor_hours: 12,
    work_type: 'malning',
    housing_designation: 'Stockholm Vasastan 1:23',
    ...overrides,
  })
}

function textItem(overrides: Partial<Item> = {}): Item {
  return plainItem({
    line_type: 'text',
    description: 'Enligt offert 2026-14',
    quantity: 0,
    unit: '',
    unit_price: 0,
    vat_rate: 0,
    ...overrides,
  })
}

function form(overrides: Partial<FormData> = {}): FormData {
  return {
    customer_id: 'cust-1',
    invoice_date: '2026-08-17',
    due_date: '2026-09-16',
    delivery_date: '',
    currency: 'SEK',
    document_type: 'invoice',
    your_reference: 'Anna',
    our_reference: 'Jakob',
    notes: 'Tack för samarbetet',
    payment_link_url: '',
    payment_link_auto: true,
    external_invoice_number: '',
    self_billing_agreement_ref: '',
    received_date: '',
    deduction_personnummer: '',
    deduction_housing_designation: '',
    items: [plainItem()],
    ...overrides,
  }
}

const jsonOf = (v: unknown) => JSON.stringify(v)

// ---------------------------------------------------------------------------
// Parity matrix: create / draft / edit x deduction x dimensions x text rows
// ---------------------------------------------------------------------------

describe('buildInvoiceWritePayload parity with the legacy inline builders', () => {
  const itemVariants: Array<[string, Item[]]> = [
    ['plain single line', [plainItem()]],
    ['ROT deduction line', [rotItem()]],
    ['mixed rot + plain + text', [rotItem(), plainItem(), textItem()]],
    [
      'dimensions: empty bag pruned, non-empty kept',
      [
        plainItem({ dimensions: {} }),
        plainItem({ dimensions: { '1': 'KS01', '6': 'P001' } }),
      ],
    ],
    [
      'accrual line without deduction keeps accrual fields',
      [
        plainItem({
          accrual_period_start: '2026-09-01',
          accrual_period_end: '2026-12-31',
          accrual_balance_account: '2990',
        }),
      ],
    ],
    [
      'RUT with per-item override account and dims',
      [
        rotItem({
          deduction_type: 'rut',
          work_type: 'stadning',
          revenue_account: '3041',
          dimensions: { '6': 'P002' },
        }),
      ],
    ],
  ]

  const formVariants: Array<[string, Partial<FormData>]> = [
    ['default create form', {}],
    [
      'claim fields filled',
      { deduction_personnummer: '19800101-1234', deduction_housing_designation: 'Berga 2:11' },
    ],
    [
      'self-billing carriers accidentally non-empty are stripped',
      { external_invoice_number: 'K-99', self_billing_agreement_ref: 'AVT-1', received_date: '2026-08-01' },
    ],
    ['EUR proforma with payment link', { currency: 'EUR', document_type: 'proforma', payment_link_url: 'https://buy.stripe.com/x' }],
  ]

  for (const [itemLabel, items] of itemVariants) {
    for (const [formLabel, formOverrides] of formVariants) {
      const data = form({ ...formOverrides, items })
      const dimsVariants: Array<Record<string, string>> = [{}, { '1': 'KS01' }]
      for (const oreRounding of [true, false]) {
        for (const defaultDims of dimsVariants) {
          it(`create: ${itemLabel} / ${formLabel} / ore=${oreRounding} / dims=${jsonOf(defaultDims)}`, () => {
            expect(
              jsonOf(buildInvoiceWritePayload(data, { oreRounding, defaultDims })),
            ).toBe(jsonOf(legacyCreatePayload(data, oreRounding, defaultDims)))
          })
          it(`draft: ${itemLabel} / ${formLabel} / ore=${oreRounding} / dims=${jsonOf(defaultDims)}`, () => {
            expect(
              jsonOf(
                buildInvoiceWritePayload(data, { saveAsDraft: true, oreRounding, defaultDims }),
              ),
            ).toBe(jsonOf(legacyDraftPayload(data, oreRounding, defaultDims)))
          })
          it(`edit: ${itemLabel} / ${formLabel} / ore=${oreRounding} / dims=${jsonOf(defaultDims)}`, () => {
            expect(
              jsonOf(buildInvoiceWritePayload(data, { oreRounding, defaultDims })),
            ).toBe(jsonOf(legacyEditPayload(data, oreRounding, defaultDims)))
          })
        }
      }
    }
  }
})

describe('buildInvoiceWritePayload semantics', () => {
  it('drops the self-billing carriers from the wire body', () => {
    const body = JSON.parse(
      jsonOf(
        buildInvoiceWritePayload(
          form({ external_invoice_number: 'X', self_billing_agreement_ref: 'Y', received_date: '2026-01-01' }),
          { oreRounding: true, defaultDims: {} },
        ),
      ),
    )
    expect(body).not.toHaveProperty('external_invoice_number')
    expect(body).not.toHaveProperty('self_billing_agreement_ref')
    expect(body).not.toHaveProperty('received_date')
  })

  it('omits save_as_draft entirely unless requested', () => {
    const noDraft = buildInvoiceWritePayload(form(), { oreRounding: true, defaultDims: {} })
    expect('save_as_draft' in noDraft).toBe(false)
    const draft = buildInvoiceWritePayload(form(), {
      saveAsDraft: true,
      oreRounding: true,
      defaultDims: {},
    })
    expect(draft.save_as_draft).toBe(true)
  })

  it('strips invoice-level personnummer/housing when no line claims a deduction', () => {
    const body = JSON.parse(
      jsonOf(
        buildInvoiceWritePayload(
          form({
            deduction_personnummer: '19800101-1234',
            deduction_housing_designation: 'Berga 2:11',
            items: [plainItem()],
          }),
          { oreRounding: true, defaultDims: {} },
        ),
      ),
    )
    expect(body).not.toHaveProperty('deduction_personnummer')
    expect(body).not.toHaveProperty('deduction_housing_designation')
  })

  it('keeps invoice-level personnummer/housing when any line claims a deduction', () => {
    const body = JSON.parse(
      jsonOf(
        buildInvoiceWritePayload(
          form({
            deduction_personnummer: '19800101-1234',
            deduction_housing_designation: 'Berga 2:11',
            items: [rotItem(), plainItem()],
          }),
          { oreRounding: true, defaultDims: {} },
        ),
      ),
    )
    expect(body.deduction_personnummer).toBe('19800101-1234')
    expect(body.deduction_housing_designation).toBe('Berga 2:11')
  })

  it('privacy-strips the six ROT/RUT fields only from non-deduction lines', () => {
    const body = JSON.parse(
      jsonOf(
        buildInvoiceWritePayload(form({ items: [rotItem(), plainItem()] }), {
          oreRounding: false,
          defaultDims: {},
        }),
      ),
    )
    expect(body.items[0].deduction_type).toBe('rot')
    expect(body.items[0].labor_hours).toBe(12)
    expect(body.items[0].work_type).toBe('malning')
    for (const key of [
      'deduction_type',
      'labor_hours',
      'work_type',
      'housing_designation',
      'apartment_number',
      'brf_org_number',
    ]) {
      expect(body.items[1]).not.toHaveProperty(key)
    }
    // Non-personal fields survive the strip.
    expect(body.items[1].description).toBe('Konsulttid')
    expect(body.items[1].accrual_period_start).toBeNull()
  })

  it('always sends ore_rounding and default_dimensions ({} clears)', () => {
    const body = JSON.parse(
      jsonOf(buildInvoiceWritePayload(form(), { oreRounding: false, defaultDims: {} })),
    )
    expect(body.ore_rounding).toBe(false)
    expect(body.default_dimensions).toEqual({})
  })
})

describe('pruneItemDimensions', () => {
  it('turns empty and null bags into undefined (inherit) and keeps valued bags', () => {
    const [a, b, c] = pruneItemDimensions([
      plainItem({ dimensions: {} }),
      plainItem({ dimensions: null }),
      plainItem({ dimensions: { '1': 'KS01' } }),
    ])
    expect(a.dimensions).toBeUndefined()
    expect(b.dimensions).toBeUndefined()
    expect(c.dimensions).toEqual({ '1': 'KS01' })
  })
})

describe('hasDimensionValues', () => {
  it('is false for null/undefined/empty and true for a valued bag', () => {
    expect(hasDimensionValues(null)).toBe(false)
    expect(hasDimensionValues(undefined)).toBe(false)
    expect(hasDimensionValues({})).toBe(false)
    expect(hasDimensionValues({ '6': 'P001' })).toBe(true)
  })
})

describe('stripSelfBillingFields / sanitizeDeductionItems', () => {
  it('stripSelfBillingFields removes exactly the three carriers', () => {
    const out = stripSelfBillingFields(form()) as Record<string, unknown>
    expect(out).not.toHaveProperty('external_invoice_number')
    expect(out).not.toHaveProperty('self_billing_agreement_ref')
    expect(out).not.toHaveProperty('received_date')
    expect(out.customer_id).toBe('cust-1')
    expect(out.items).toHaveLength(1)
  })

  it('sanitizeDeductionItems leaves deduction lines untouched (same reference)', () => {
    const rot = rotItem()
    const out = sanitizeDeductionItems([rot])
    expect(out[0]).toBe(rot)
  })
})

describe('buildSelfBilledPayload parity and semantics', () => {
  const selfBilledForm = form({
    external_invoice_number: 'K-2026-17',
    self_billing_agreement_ref: '',
    received_date: '2026-08-15',
    notes: 'Mottagen självfaktura',
    items: [
      plainItem({ article_id: 'art-1', revenue_account: '3001', dimensions: { '1': 'KS01' } }),
      plainItem({ description: 'Frakt', quantity: 1, unit: 'st', unit_price: 120, vat_rate: 25 }),
    ],
  })

  it('matches the legacy inline body byte for byte', () => {
    expect(jsonOf(buildSelfBilledPayload(selfBilledForm))).toBe(
      jsonOf(legacySelfBilledPayload(selfBilledForm)),
    )
  })

  it('reduces items to the five wire fields', () => {
    const body = JSON.parse(jsonOf(buildSelfBilledPayload(selfBilledForm)))
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'description',
      'quantity',
      'unit',
      'unit_price',
      'vat_rate',
    ])
  })

  it("coerces an empty agreement ref to undefined so it drops off the wire", () => {
    const body = JSON.parse(jsonOf(buildSelfBilledPayload(selfBilledForm)))
    expect(body).not.toHaveProperty('self_billing_agreement_ref')
    const withRef = JSON.parse(
      jsonOf(buildSelfBilledPayload({ ...selfBilledForm, self_billing_agreement_ref: 'AVT-9' })),
    )
    expect(withRef.self_billing_agreement_ref).toBe('AVT-9')
  })

  it('never sends document_type, ROT/RUT or payment-link fields', () => {
    const body = JSON.parse(jsonOf(buildSelfBilledPayload(selfBilledForm)))
    for (const key of ['document_type', 'payment_link_url', 'payment_link_auto', 'ore_rounding', 'deduction_personnummer']) {
      expect(body).not.toHaveProperty(key)
    }
  })
})
