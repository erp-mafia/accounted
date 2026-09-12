import { describe, expect, it } from 'vitest'
import { INVOICE_LIST_TABS } from '../invoice-list-tabs'
import {
  INVOICE_TYPE_TOGGLES,
  isInvoiceTypeEnabled,
  visibleInvoiceListTabs,
} from '../invoice-type-toggles'

describe('isInvoiceTypeEnabled', () => {
  it('defaults every kind to on when the settings row is missing or silent', () => {
    for (const toggle of INVOICE_TYPE_TOGGLES) {
      expect(isInvoiceTypeEnabled(null, toggle)).toBe(true)
      expect(isInvoiceTypeEnabled(undefined, toggle)).toBe(true)
      expect(isInvoiceTypeEnabled({}, toggle)).toBe(true)
    }
  })

  it('reads the stored flag when present', () => {
    expect(isInvoiceTypeEnabled({ quotes_enabled: false }, 'quotes_enabled')).toBe(false)
    expect(isInvoiceTypeEnabled({ quotes_enabled: false }, 'proforma_enabled')).toBe(true)
  })
})

describe('visibleInvoiceListTabs', () => {
  it('offers every view when nothing is switched off', () => {
    expect(visibleInvoiceListTabs(INVOICE_LIST_TABS, {}, 'all')).toEqual([...INVOICE_LIST_TABS])
  })

  it('drops the proforma view when proformas are switched off', () => {
    const tabs = visibleInvoiceListTabs(INVOICE_LIST_TABS, { proforma_enabled: false }, 'all')
    expect(tabs).not.toContain('proforma')
    expect(tabs).toContain('delivery_note')
    expect(tabs).toContain('all')
  })

  it('keeps the active view even when its kind is switched off (bookmarked ?status=proforma)', () => {
    const tabs = visibleInvoiceListTabs(INVOICE_LIST_TABS, { proforma_enabled: false }, 'proforma')
    expect(tabs).toContain('proforma')
  })

  it('has no invoice list view to hide for quotes, recurring and self-billing', () => {
    const tabs = visibleInvoiceListTabs(
      INVOICE_LIST_TABS,
      { quotes_enabled: false, recurring_invoices_enabled: false, self_billing_enabled: false },
      'all',
    )
    expect(tabs).toEqual([...INVOICE_LIST_TABS])
  })
})
