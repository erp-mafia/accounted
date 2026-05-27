// Route → intent dispatch for the floating "Fråga [namn]" trigger.
//
// The page-specific buttons ("Granska med assistent" on a supplier invoice
// page, "Fråga om bokslutet" in the year-end wizard) already open the right
// intent because they know what they're attached to. The floating FAB
// previously always opened general.help with just the URL string, so clicking
// it on /invoices/abc-123 gave the agent zero context about that invoice.
//
// This module gives the FAB the same situational awareness: it inspects the
// pathname and picks the intent + intentArgs that the equivalent on-page
// button would have used.
//
// Pure function, no React deps — easy to test, easy to extend with new
// routes as more intents land.

export interface RouteIntent {
  intentId: string
  intentArgs: Record<string, unknown>
  // Persisted on agent_conversations.context_ref so /chat can back-link.
  contextRef?: string
  // Short suffix appended to the FAB label ("Fråga [namn] om denna faktura").
  // null → just "Fråga [namn]".
  labelSuffix: string | null
}

const GENERAL_HELP = (route: string | null): RouteIntent => ({
  intentId: 'general.help',
  intentArgs: { route: route ?? undefined },
  labelSuffix: null,
})

export function routeToIntent(pathname: string | null | undefined): RouteIntent {
  if (!pathname) return GENERAL_HELP(null)

  const segments = pathname.split('/').filter(Boolean)
  const [first, second] = segments

  // /invoices/new — drafting a brand-new invoice (no entity id yet).
  if (first === 'invoices' && second === 'new') {
    return {
      intentId: 'invoice.draft',
      intentArgs: {},
      labelSuffix: 'om denna faktura',
    }
  }

  // /invoices/[id] and /invoices/[id]/credit — entity in focus.
  if (first === 'invoices' && second && second !== 'new') {
    return {
      intentId: 'invoice.draft',
      intentArgs: { invoice_id: second },
      contextRef: `invoice:${second}`,
      labelSuffix: 'om denna faktura',
    }
  }

  // /supplier-invoices/[id] — review/attest flow.
  // /supplier-invoices/new has no entity to review yet — fall through to
  // general.help so the agent doesn't load a heavy Opus intent on an empty
  // capture.
  if (first === 'supplier-invoices' && second && second !== 'new') {
    return {
      intentId: 'supplier_invoice.review',
      intentArgs: { supplier_invoice_id: second },
      contextRef: `supplier_invoice:${second}`,
      labelSuffix: 'om denna leverantörsfaktura',
    }
  }

  // /bookkeeping/year-end — the bokslut wizard. Match the page's "Fråga om
  // bokslutet" button (bokslut.step) instead of general.help, so the FAB and the
  // page button open the SAME assistant here rather than two different ones.
  if (first === 'bookkeeping' && second === 'year-end') {
    return {
      intentId: 'bokslut.step',
      intentArgs: { step_id: null },
      contextRef: 'bokslut:overview',
      labelSuffix: 'om bokslutet',
    }
  }

  // /bookkeeping/[id] (single verifikation) is intentionally NOT mapped
  // here — AgentTrigger suppresses the FAB on that route entirely. The
  // verifikation editor is a dense regulatory surface and the floating
  // pill earned its way off the page.

  // /kpi — nyckeltal dashboard. Match the page's "Fråga om nyckeltalen" button
  // (kpi.explain) so the FAB and the page button agree on this page.
  if (first === 'kpi') {
    return {
      intentId: 'kpi.explain',
      intentArgs: { kpi_key: 'översikt' },
      contextRef: 'kpi:översikt',
      labelSuffix: 'om nyckeltalen',
    }
  }

  // Note: /transactions and /reports intentionally fall through to general.help.
  // Their on-page triggers are entity/view-specific (a transaction row needs a
  // transaction_id; the VAT report button needs the selected period/view) — the
  // FAB only knows the pathname, so page-level help is the honest default there.

  // /settings/<panel>[/...] — settings.help captures which panel is active.
  // Uses the second segment as panel slug so /settings/invoicing/templates
  // still surfaces panel=invoicing.
  if (first === 'settings' && second) {
    return {
      intentId: 'settings.help',
      intentArgs: { panel: second },
      labelSuffix: null,
    }
  }

  return GENERAL_HELP(pathname)
}
