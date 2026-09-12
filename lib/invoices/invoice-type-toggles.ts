import type { CompanySettings } from '@/types'
import type { InvoiceListTab } from './invoice-list-tabs'

/**
 * The optional invoice kinds a company can hide from the UI (Inställningar >
 * Försäljning). Faktura itself is not on the list: it is the product, not an
 * option. Följesedel is not on it either: it has no entry point of its own.
 *
 * The toggles gate visibility only, never correctness: a hidden kind keeps
 * working through the API/MCP, its existing documents stay listed under
 * Alla and its pages stay reachable by URL.
 */
export const INVOICE_TYPE_TOGGLES = [
  'quotes_enabled',
  'proforma_enabled',
  'recurring_invoices_enabled',
  'self_billing_enabled',
] as const

export type InvoiceTypeToggle = (typeof INVOICE_TYPE_TOGGLES)[number]

export type InvoiceTypeFlags = Partial<Pick<CompanySettings, InvoiceTypeToggle>> | null | undefined

/** Every toggle defaults to on, so a missing settings row hides nothing. */
export function isInvoiceTypeEnabled(settings: InvoiceTypeFlags, toggle: InvoiceTypeToggle): boolean {
  return settings?.[toggle] ?? true
}

/** Which list view (if any) each toggle hides when off. */
const TAB_BY_TOGGLE: Partial<Record<InvoiceTypeToggle, InvoiceListTab>> = {
  quotes_enabled: 'quote',
  proforma_enabled: 'proforma',
}

/**
 * The status views to offer given the company's toggles. The active view is
 * always kept: a bookmarked ?status=quote must not land on a picker whose
 * current value is missing from its own items.
 */
export function visibleInvoiceListTabs(
  tabs: readonly InvoiceListTab[],
  settings: InvoiceTypeFlags,
  activeTab: InvoiceListTab,
): InvoiceListTab[] {
  const hidden = new Set<InvoiceListTab>()
  for (const toggle of INVOICE_TYPE_TOGGLES) {
    const tab = TAB_BY_TOGGLE[toggle]
    if (tab && !isInvoiceTypeEnabled(settings, toggle)) hidden.add(tab)
  }
  return tabs.filter((tab) => tab === activeTab || !hidden.has(tab))
}
