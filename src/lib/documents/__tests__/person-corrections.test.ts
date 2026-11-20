import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  carriedPersonFields,
  correctionPaths,
  keepPersonChoices,
  keepPersonCorrections,
  keepStoredPersonChoices,
  personFieldPaths,
  withPersonFields,
} from '../person-corrections'
import { mergeInboxItemFields } from '../inbox-item-actions'
import type { InvoiceExtractionResult } from '@/types'

const CHOICE = { code: 'expense.equipment.hardware', source: 'person', set_at: '2026-10-15T09:00:00.000Z', set_via: 'dashboard' }

const MODEL: InvoiceExtractionResult = {
  supplier: { name: 'Exempel AB', orgNumber: '5500000001', vatNumber: null, address: null, bankgiro: '1234567', plusgiro: null },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-10-01', dueDate: '2026-10-31', paymentReference: null, currency: 'SEK' },
  lineItems: [],
  totals: { subtotal: 100, vatAmount: 25, total: 125 },
  vatBreakdown: [],
  totalSource: 'prominent',
  confidence: 1,
}

const FRESH: InvoiceExtractionResult = {
  ...MODEL,
  supplier: { ...MODEL.supplier, name: 'Exempel Aktiebolag' },
  invoice: { ...MODEL.invoice, dueDate: '2026-11-15' },
  totals: { subtotal: 100, vatAmount: 25, total: 130 },
}

describe('correctionPaths', () => {
  it('names every key a correction writes, a cleared field included, in one order', () => {
    expect(
      correctionPaths({
        totals: { total: 99 },
        supplier: { name: 'Ny', bankgiro: null },
        invoice: { dueDate: undefined },
        documentKind: 'receipt',
      }),
    ).toEqual(['documentKind', 'supplier.name', 'supplier.bankgiro', 'totals.total'])
    expect(correctionPaths({})).toEqual([])
  })
})

describe('personFieldPaths and withPersonFields', () => {
  it('reads only known paths and merges new ones without duplicates', () => {
    expect(personFieldPaths({ personFields: ['totals.total', 'nope', 7, 'supplier.name'] })).toEqual(['supplier.name', 'totals.total'])
    expect(personFieldPaths(null)).toEqual([])
    expect(personFieldPaths({ personFields: 'supplier.name' })).toEqual([])
    const once = withPersonFields({ personFields: ['totals.total'] }, ['supplier.name', 'totals.total'])
    expect(once).toEqual({ personFields: ['supplier.name', 'totals.total'] })
  })

  it('leaves a reading without new paths untouched', () => {
    const reading = { supplier: { name: 'x' } }
    expect(withPersonFields(reading, [])).toBe(reading)
  })
})

describe('mergeInboxItemFields', () => {
  it('records the paths a correction wrote beside the reading', () => {
    const merged = mergeInboxItemFields(MODEL, { invoice: { dueDate: '2026-12-01' } }) as unknown as Record<string, unknown>
    expect(merged.personFields).toEqual(['invoice.dueDate'])
    const again = mergeInboxItemFields(merged as unknown as InvoiceExtractionResult, { supplier: { name: null } })
    expect((again as unknown as Record<string, unknown>).personFields).toEqual(['supplier.name', 'invoice.dueDate'])
  })
})

describe('keepPersonCorrections', () => {
  it('copies what a person corrected onto a new reading, and keeps the list', () => {
    const corrected = mergeInboxItemFields(MODEL, { invoice: { dueDate: '2026-12-01' }, supplier: { name: null } })
    const out = keepPersonCorrections(corrected, FRESH) as unknown as Record<string, unknown>
    expect(out.invoice).toEqual({ ...FRESH.invoice, dueDate: '2026-12-01' })
    expect(out.supplier).toEqual({ ...FRESH.supplier, name: null })
    expect(out.totals).toEqual(FRESH.totals)
    expect(out.personFields).toEqual(['supplier.name', 'invoice.dueDate'])
  })

  it('keeps a hand-set total verified', () => {
    const corrected = mergeInboxItemFields(MODEL, { totals: { total: 125.5 } })
    const out = keepPersonCorrections(corrected, FRESH)
    expect(out.totals.total).toBe(125.5)
    expect(out.totalSource).toBeNull()
  })

  it('carries the kind a person set', () => {
    const corrected = mergeInboxItemFields(MODEL, { documentKind: 'credit_note' })
    expect(keepPersonCorrections(corrected, FRESH).documentKind).toBe('credit_note')
  })

  it('returns the new reading as it is when nothing was corrected', () => {
    expect(keepPersonCorrections(MODEL, FRESH)).toBe(FRESH)
    expect(keepPersonCorrections(null, FRESH)).toBe(FRESH)
    expect(carriedPersonFields(MODEL)).toBe(false)
  })
})

describe('keepPersonChoices', () => {
  it('carries the corrected fields and the purchase category together', () => {
    const corrected = { ...mergeInboxItemFields(MODEL, { invoice: { invoiceNumber: 'F-9' } }), purchaseCategory: CHOICE }
    const out = keepPersonChoices(corrected, FRESH) as unknown as Record<string, unknown>
    expect((out.invoice as Record<string, unknown>).invoiceNumber).toBe('F-9')
    expect(out.purchaseCategory).toEqual(CHOICE)
    expect(carriedPersonFields(corrected)).toBe(true)
  })
})

describe('keepStoredPersonChoices', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient
  beforeEach(() => mock.reset())

  it('reads the row, scoped to the company, and carries what the person decided', async () => {
    const corrected = { ...mergeInboxItemFields(MODEL, { invoice: { invoiceNumber: 'F-9' } }), purchaseCategory: CHOICE }
    mock.enqueue({ data: { extracted_data: corrected } })
    const { reading, carriedFields } = await keepStoredPersonChoices(supabase, 'item-1', 'company-1', FRESH)
    expect(carriedFields).toBe(true)
    expect(reading.invoice.invoiceNumber).toBe('F-9')
    expect((reading as unknown as Record<string, unknown>).purchaseCategory).toEqual(CHOICE)
    expect(mock.findCalls('invoice_inbox_items', 'eq')).toEqual([
      ['id', 'item-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('carries nothing when the read fails, so the extraction still lands', async () => {
    mock.enqueue({ data: null, error: { message: 'timeout' } })
    expect(await keepStoredPersonChoices(supabase, 'item-1', 'company-1', FRESH)).toEqual({ reading: FRESH, carriedFields: false })
    const broken = { from: () => { throw new Error('no client') } } as unknown as SupabaseClient
    expect(await keepStoredPersonChoices(broken, 'item-1', 'company-1', FRESH)).toEqual({ reading: FRESH, carriedFields: false })
  })
})
