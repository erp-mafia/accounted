/**
 * The guard of a new invoice's Märkning: what the request or the source
 * document states, else the customer card's, is chosen in one place, so a
 * door that holds a stated Märkning cannot fall back to the card alone.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/invoice-marking-for-new-invoice.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('invoice-marking-for-new-invoice', () => {
  it.each([
    // The order door as it was: the card's Märkning alone.
    'invoice_marking: customerInvoiceMarking(customer) ?? undefined,',
    // The same through the home, with the stated Märkning left out.
    'invoice_marking: invoiceMarkingForNewInvoice(null, customer),',
    'invoice_marking: invoiceMarkingForNewInvoice(undefined, customer) ?? undefined,',
    // The card's field copied, or fallen back to, by hand.
    'invoice_marking: customer.invoice_marking?.trim() || null,',
    'invoice_marking: order.invoice_marking || customer.invoice_marking,',
    'const marking = source.invoice_marking?.trim() || customer?.invoice_marking?.trim() || null',
    'invoice_marking: input.invoice_marking ?? source.customer?.invoice_marking ?? null,',
  ])('flags: %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'invoice_marking: invoiceMarkingForNewInvoice(order.invoice_marking, customer) ?? undefined,',
    "import { invoiceMarkingForNewInvoice } from '@/lib/customers/invoice-marking'",
    // Copying a stated Märkning onto a new document is not choosing one.
    'invoice_marking: source.invoice_marking ?? null,',
    // An issued invoice keeps the Märkning it was issued with.
    'invoice_marking: original.invoice_marking ?? null,',
    'invoice_marking: input.invoice_marking?.trim() || null,',
    // Showing the card's own field.
    '{customer.invoice_marking && (',
    "<DefRow label={t('def_invoice_marking')}>{customer.invoice_marking}</DefRow>",
  ])('leaves: %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
