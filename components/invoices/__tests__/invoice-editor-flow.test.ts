import { describe, it, expect } from 'vitest'
import {
  deriveNextStep,
  deriveForvalChips,
  deriveRequiresHousing,
  filterArticleSuggestions,
  type NextStepInput,
  type ForvalChipsInput,
} from '@/components/invoices/invoice-editor-flow'

function stepInput(overrides: Partial<NextStepInput> = {}): NextStepInput {
  return {
    isSelfBilled: false,
    customerSelected: true,
    invoiceDate: '2026-08-17',
    dueDate: '2026-09-16',
    receivedDate: '',
    externalInvoiceNumber: '',
    items: [
      { line_type: 'product', description: 'Konsulttid', quantity: 10, unit: 'tim', unit_price: 1200 },
    ],
    paymentLinkInvalid: false,
    requiresPersonnummer: false,
    personnummer: '',
    requiresHousing: false,
    housingDesignation: '',
    ...overrides,
  }
}

describe('deriveNextStep priority order', () => {
  it('is ready for a complete invoice', () => {
    expect(deriveNextStep(stepInput())).toEqual({ kind: 'ready' })
  })

  it('customer comes first, before everything else', () => {
    expect(
      deriveNextStep(stepInput({ customerSelected: false, invoiceDate: '', items: [] })),
    ).toEqual({ kind: 'customer' })
  })

  it('dates come before rows', () => {
    expect(deriveNextStep(stepInput({ invoiceDate: '', items: [] }))).toEqual({
      kind: 'invoice_date',
    })
    expect(deriveNextStep(stepInput({ dueDate: '', items: [] }))).toEqual({ kind: 'due_date' })
  })

  it('asks for a first row when only text rows exist', () => {
    expect(
      deriveNextStep(stepInput({ items: [{ line_type: 'text', description: 'Enligt offert' }] })),
    ).toEqual({ kind: 'rows_empty' })
  })

  it('flags the first incomplete row, field by field, skipping text rows', () => {
    const items: NextStepInput['items'] = [
      { line_type: 'text', description: '' },
      { line_type: 'product', description: 'Ok', quantity: 1, unit: 'st', unit_price: 100 },
      { line_type: 'product', description: '', quantity: 1, unit: 'st', unit_price: 0 },
    ]
    expect(deriveNextStep(stepInput({ items }))).toEqual({
      kind: 'row_incomplete',
      index: 2,
      field: 'description',
    })
    items[2].description = 'Rad'
    items[2].quantity = 0
    expect(deriveNextStep(stepInput({ items }))).toEqual({
      kind: 'row_incomplete',
      index: 2,
      field: 'quantity',
    })
    items[2].quantity = NaN
    expect(deriveNextStep(stepInput({ items }))).toEqual({
      kind: 'row_incomplete',
      index: 2,
      field: 'quantity',
    })
    items[2].quantity = 2
    items[2].unit = ''
    expect(deriveNextStep(stepInput({ items }))).toEqual({
      kind: 'row_incomplete',
      index: 2,
      field: 'unit',
    })
    items[2].unit = 'st'
    items[2].unit_price = NaN
    expect(deriveNextStep(stepInput({ items }))).toEqual({
      kind: 'row_incomplete',
      index: 2,
      field: 'unit_price',
    })
  })

  it('allows negative and zero unit prices (discount lines)', () => {
    expect(
      deriveNextStep(
        stepInput({
          items: [
            { line_type: 'product', description: 'Rabatt', quantity: 1, unit: 'st', unit_price: -100 },
          ],
        }),
      ),
    ).toEqual({ kind: 'ready' })
  })

  it('routes to the payment link after rows', () => {
    expect(deriveNextStep(stepInput({ paymentLinkInvalid: true }))).toEqual({
      kind: 'payment_link',
    })
  })

  it('asks for personnummer only when neither draft nor kundkort covers it', () => {
    expect(deriveNextStep(stepInput({ requiresPersonnummer: true }))).toEqual({
      kind: 'personnummer',
    })
    expect(
      deriveNextStep(stepInput({ requiresPersonnummer: true, personnummer: '19800101-1234' })),
    ).toEqual({ kind: 'ready' })
    // Server fallback (stored last4 / kundkort) => requiresPersonnummer false.
    expect(deriveNextStep(stepInput({ requiresPersonnummer: false }))).toEqual({ kind: 'ready' })
  })

  it('asks for fastighetsbeteckning when a ROT line exists', () => {
    expect(deriveNextStep(stepInput({ requiresHousing: true }))).toEqual({ kind: 'housing' })
    expect(
      deriveNextStep(stepInput({ requiresHousing: true, housingDesignation: 'Berga 2:11' })),
    ).toEqual({ kind: 'ready' })
  })

  it('skips the housing step for a ROT row whose amount is still zero (transient state)', () => {
    // The claim card only mounts while a deduction amount is claimed, so a
    // ROT-flagged row with price 0 must not produce a housing step: the
    // next-step link would try to focus an unmounted field.
    const requiresHousing = deriveRequiresHousing({ hasRotLine: true, deductionTotal: 0 })
    expect(requiresHousing).toBe(false)
    expect(deriveNextStep(stepInput({ requiresHousing }))).toEqual({ kind: 'ready' })
  })

  it('requires housing once the ROT deduction carries an amount, but never for RUT alone', () => {
    expect(deriveRequiresHousing({ hasRotLine: true, deductionTotal: 360 })).toBe(true)
    expect(deriveRequiresHousing({ hasRotLine: false, deductionTotal: 500 })).toBe(false)
  })

  it('self-billed extras come last: external number then received date', () => {
    expect(deriveNextStep(stepInput({ isSelfBilled: true }))).toEqual({ kind: 'external_number' })
    expect(
      deriveNextStep(stepInput({ isSelfBilled: true, externalInvoiceNumber: 'K-1' })),
    ).toEqual({ kind: 'received_date' })
    expect(
      deriveNextStep(
        stepInput({ isSelfBilled: true, externalInvoiceNumber: 'K-1', receivedDate: '2026-08-15' }),
      ),
    ).toEqual({ kind: 'ready' })
  })
})

function chipsInput(overrides: Partial<ForvalChipsInput> = {}): ForvalChipsInput {
  return {
    isSelfBilled: false,
    documentType: 'invoice',
    currency: 'SEK',
    invoiceDate: '2026-08-17',
    dueDate: '2026-09-16',
    receivedDate: '',
    deliveryDate: '',
    yourReference: '',
    invoiceMarking: '',
    paymentLink: null,
    oreRounding: true,
    dims: null,
    ...overrides,
  }
}

describe('deriveForvalChips', () => {
  it('shows currency, invoice date and due terms for an all-default invoice', () => {
    expect(deriveForvalChips(chipsInput())).toEqual([
      { kind: 'currency', currency: 'SEK' },
      { kind: 'invoice_date', date: '2026-08-17' },
      { kind: 'due_days', days: 30, date: '2026-09-16' },
    ])
  })

  // Issue #1820: the invoice date silently defaulted to today inside the
  // collapsed Förval panel; the chip makes the value visible in every mode.
  it('surfaces the invoice date as a chip, and skips it while unset', () => {
    expect(deriveForvalChips(chipsInput())).toContainEqual({
      kind: 'invoice_date',
      date: '2026-08-17',
    })
    expect(deriveForvalChips(chipsInput({ isSelfBilled: true }))).toContainEqual({
      kind: 'invoice_date',
      date: '2026-08-17',
    })
    expect(
      deriveForvalChips(chipsInput({ invoiceDate: '' })).find((c) => c.kind === 'invoice_date'),
    ).toBeUndefined()
  })

  it('surfaces a deviating document type first', () => {
    expect(deriveForvalChips(chipsInput({ documentType: 'proforma' }))[0]).toEqual({
      kind: 'doc_type',
      documentType: 'proforma',
    })
  })

  it('falls back to a plain due date when the invoice date is missing or after', () => {
    expect(deriveForvalChips(chipsInput({ invoiceDate: '' }))).toContainEqual({
      kind: 'due_date',
      date: '2026-09-16',
    })
    expect(
      deriveForvalChips(chipsInput({ invoiceDate: '2026-10-01', dueDate: '2026-09-16' })),
    ).toContainEqual({ kind: 'due_date', date: '2026-09-16' })
  })

  it('surfaces every deviation an edit/copy draft may carry', () => {
    const chips = deriveForvalChips(
      chipsInput({
        documentType: 'proforma',
        currency: 'EUR',
        deliveryDate: '2026-08-20',
        yourReference: 'Anna',
        invoiceMarking: 'KST 4711',
        paymentLink: 'manual',
        oreRounding: false,
        dims: 'KS01 · P001',
      }),
    )
    expect(chips).toContainEqual({ kind: 'doc_type', documentType: 'proforma' })
    expect(chips).toContainEqual({ kind: 'currency', currency: 'EUR' })
    expect(chips).toContainEqual({ kind: 'delivery', date: '2026-08-20' })
    expect(chips).toContainEqual({ kind: 'your_reference', reference: 'Anna' })
    expect(chips).toContainEqual({ kind: 'invoice_marking', marking: 'KST 4711' })
    expect(chips).toContainEqual({ kind: 'payment_link', mode: 'manual' })
    expect(chips).toContainEqual({ kind: 'dims', dims: 'KS01 · P001' })
    // ore_off is SEK-only: an EUR invoice has no öresavrundning to disable.
    expect(chips.find((c) => c.kind === 'ore_off')).toBeUndefined()
  })

  it('flags disabled öresavrundning on SEK invoices', () => {
    expect(deriveForvalChips(chipsInput({ oreRounding: false }))).toContainEqual({
      kind: 'ore_off',
    })
  })

  it('reduces to currency, invoice date, due and received for self-billed mode', () => {
    const chips = deriveForvalChips(
      chipsInput({
        isSelfBilled: true,
        receivedDate: '2026-08-15',
        documentType: 'proforma',
        yourReference: 'x',
        invoiceMarking: 'x',
        paymentLink: 'auto',
        oreRounding: false,
        dims: 'KS01',
      }),
    )
    expect(chips).toEqual([
      { kind: 'currency', currency: 'SEK' },
      { kind: 'invoice_date', date: '2026-08-17' },
      { kind: 'due_days', days: 30, date: '2026-09-16' },
      { kind: 'received', date: '2026-08-15' },
    ])
  })
})

describe('filterArticleSuggestions', () => {
  const articles = [
    { id: 'a', article_number: '2', name: 'Skruvdragare' },
    { id: 'b', article_number: '10', name: 'Städning, kontor' },
    { id: 'c', article_number: null, name: 'Konsulttid' },
  ]

  it('browses everything on an empty query', () => {
    expect(filterArticleSuggestions(articles, '')).toHaveLength(3)
    expect(filterArticleSuggestions(articles, '   ')).toHaveLength(3)
  })

  it('matches names diacritics-folded', () => {
    expect(filterArticleSuggestions(articles, 'stadning')).toEqual([articles[1]])
    expect(filterArticleSuggestions(articles, 'STÄD')).toEqual([articles[1]])
  })

  it('matches article numbers', () => {
    expect(filterArticleSuggestions(articles, '10')).toEqual([articles[1]])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterArticleSuggestions(articles, 'zzz')).toEqual([])
  })
})
