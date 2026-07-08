import type { McpResource } from './types'
import { buildLedgerContext } from '@/lib/agent-context/ledger-context'

/**
 * How this company books things, derived from the ledger itself: account
 * usage, counterparty + supplier booking patterns (with count-grounded
 * evidence), user-authored rules, observed VAT profile, and conventions.
 * Sibling of company-current (state now vs patterns over time); zero field
 * overlap.
 *
 * Read-only and per-request; caching is deferred until measured slow
 * (dev_docs/ledger_context_resource.md).
 */
export const ledgerContextResource: McpResource = {
  uri: 'Accounted://ledger/context',
  name: 'Ledger Context',
  description:
    'How this company books things: account usage, counterparty and supplier booking patterns with count-grounded evidence, explicit rules, observed VAT profile, conventions. Read before categorizing or creating vouchers; prefer these patterns over guesses. Explicit rules outrank observed patterns.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => buildLedgerContext(supabase, companyId),
}
