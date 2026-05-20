// Route → intent dispatch for the floating "Fråga [namn]" trigger.
//
// The page-specific buttons ("Fråga om denna transaktion" on a row, "Granska
// med assistent" on a supplier invoice page) already open the right intent
// because they know what they're attached to. The floating FAB previously
// always opened general.help with just the URL string, so clicking it on
// /invoices/abc-123 gave the agent zero context about that invoice.
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

  // /bookkeeping/[id] — single verifikation. /bookkeeping/year-end is a
  // multi-step wizard, not a single entity, so it falls through.
  if (first === 'bookkeeping' && second && second !== 'year-end' && second !== 'new') {
    return {
      intentId: 'verifikation.draft',
      intentArgs: { journal_entry_id: second },
      contextRef: `journal_entry:${second}`,
      labelSuffix: 'om denna verifikation',
    }
  }

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
