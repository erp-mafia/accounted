/**
 * Where a role's preset (./presets.ts) and today's route gate disagree on
 * purpose: the documented exceptions of __tests__/preset-equivalence.test.ts,
 * which compares every dashboard write route's gate with the presets and
 * fails when this list and the routes drift apart.
 *
 * The permission shadow (./shadow.ts) reads the same lists at runtime: a
 * disagreement between decide() and today's gate on one of these routes, for
 * one of the listed roles, is logged as expected, so only unexplained
 * disagreements count toward enforcement.
 *
 * Route keys are '<METHOD> <path>' with path parameters written as :name.
 */
import type { CompanyRole } from '@/types'

/**
 * The invoicer role is a route allowlist (INVOICER_ROUTES), narrower than
 * the invoicing permission its preset holds: these invoicing routes are
 * refused to it today and stay refused by the allowlist, which
 * withRouteContext keeps applying beside the permission.
 */
export const INVOICER_OUTSIDE_ALLOWLIST: readonly string[] = [
  'DELETE /api/invoices/:id/attachments/:documentId',
  'DELETE /api/invoices/:id/underlag/:documentId',
  'DELETE /api/invoices/recurring/:id',
  'PATCH /api/customers/:id/collections-exclusion',
  'PATCH /api/customers/:id/reminders-exclusion',
  'PATCH /api/invoices/autogiro/mandates/:id',
  'PATCH /api/invoices/recurring/:id',
  'PATCH /api/rot-rut/payout-requests/:id',
  'POST /api/customers/merge',
  'POST /api/customers/merge/undo',
  'POST /api/import/articles/execute',
  'POST /api/import/customers/execute',
  'POST /api/invoices/:id/attachments',
  'POST /api/invoices/:id/book',
  'POST /api/invoices/:id/cancel',
  'POST /api/invoices/:id/collection',
  'POST /api/invoices/:id/collection/actions',
  'POST /api/invoices/:id/collection/forwards',
  'POST /api/invoices/:id/collection/possible-payments',
  'POST /api/invoices/:id/customer-loss',
  'POST /api/invoices/:id/digital-mailbox/send',
  'POST /api/invoices/:id/link-to-voucher',
  'POST /api/invoices/:id/mark-paid',
  'POST /api/invoices/:id/peppol',
  'POST /api/invoices/:id/peppol/send',
  'POST /api/invoices/:id/refresh-exchange-rate',
  'POST /api/invoices/:id/resend',
  'POST /api/invoices/:id/send-payment-confirmation',
  'POST /api/invoices/:id/uncredit',
  'POST /api/invoices/:id/underlag',
  'POST /api/invoices/autogiro/debit-files',
  'POST /api/invoices/autogiro/debit-files/:id/withdraw',
  'POST /api/invoices/autogiro/mandates',
  'POST /api/invoices/autogiro/mandates/:id/cancel',
  'POST /api/invoices/autogiro/reports',
  'POST /api/invoices/autogiro/settle',
  'POST /api/invoices/bulk-book',
  'POST /api/invoices/recurring',
  'POST /api/invoices/recurring/:id/run',
  'POST /api/invoices/self-billed',
  'POST /api/parties/:id/setoffs',
  'POST /api/reminders/send',
  'POST /api/rot-rut/beslut/import',
  'POST /api/rot-rut/payout-file',
  'POST /api/rot-rut/payout-requests/:id/link-voucher',
  'POST /api/rot-rut/payout-requests/:id/reclaim',
  'POST /api/sales-orders/:id/deliver',
  'POST /api/webshop-orders/:id/create-invoice',
  'PUT /api/invoices/autogiro/settings',
]

/**
 * Dashboard write routes that check no role today (withRouteContext without
 * requireWrite), so a viewer reaches the handler. The permission is the rule
 * the door enforces from W2b on, as W0 already did for the Arkiv revert and
 * finding routes (requireWrite). Empty since W0b gated the last two
 * (document extraction fields, party aliases).
 */
export const VIEWER_PASSES_UNGATED_ROUTE: readonly string[] = []

/**
 * Extension routes the dispatcher declares no role gate for and whose
 * handler checks none, so a viewer reaches the handler. The permission is
 * the rule the door enforces from W2b on; whether the database refused the
 * viewer's write before depends on each table's RLS (current_user_can_write)
 * and on whether the effect lands outside the database at all. Empty since
 * W0b: the dispatcher refuses viewers on every write method unless the route
 * declares viewerMay.
 */
export const EXTENSION_ROUTE_WITHOUT_ROLE_GATE: readonly string[] = []

/** Owner-only today; no preset tells the owner from an admin, who holds every permission. */
export const OWNER_ONLY: readonly string[] = [
  'POST /api/billing/payment-packs',
  'POST /api/company/:id/delete',
  'POST /api/company/:id/migration-reset',
]

/**
 * Managing one's own agent keys: requireWrite today and outside the invoicer
 * allowlist, though viewer and invoicer both connect agents on the consent
 * page (capScopesForRole caps the scopes). agents.connect lets them pause,
 * narrow or revoke what they connected; a colleague's key still needs an
 * owner or admin in the handler.
 */
export const OWN_AGENT_KEYS: readonly string[] = [
  'DELETE /api/settings/api-keys/:id',
  'PATCH /api/settings/api-keys/:id',
]

/**
 * Attest (Attestera, Neka) of a supplier invoice: a viewer whom the
 * company's attest policy names attests the invoices it governs (crm#1569),
 * so these routes check no role and the attest service and the database
 * decide (deciderRefusal, supplier_invoice_attest_ruling). The viewer's
 * preset holds no write, and no preset can say "only where the policy names
 * you": when the door enforces permissions, these stay the service's. The
 * same holds for naming one's own substitute while away (#192): any member,
 * a viewer attester too, for themselves; an owner or admin for anyone (the
 * attest service and the RLS policies of company_attest_substitutes).
 */
export const VIEWER_ATTESTS_BY_POLICY: readonly string[] = [
  'POST /api/supplier-invoices/:id/approve',
  'POST /api/supplier-invoices/:id/reject',
  'POST /api/supplier-invoices/attest-policy/substitutes',
  'DELETE /api/supplier-invoices/attest-policy/substitutes/:id',
]

export type PresetException =
  | 'INVOICER_OUTSIDE_ALLOWLIST'
  | 'VIEWER_PASSES_UNGATED_ROUTE'
  | 'EXTENSION_ROUTE_WITHOUT_ROLE_GATE'
  | 'OWNER_ONLY'
  | 'OWN_AGENT_KEYS'
  | 'VIEWER_ATTESTS_BY_POLICY'

export const PRESET_EXCEPTIONS: ReadonlyArray<{
  id: PresetException
  routes: readonly string[]
  roles: readonly CompanyRole[]
}> = [
  { id: 'INVOICER_OUTSIDE_ALLOWLIST', routes: INVOICER_OUTSIDE_ALLOWLIST, roles: ['invoicer'] },
  { id: 'VIEWER_PASSES_UNGATED_ROUTE', routes: VIEWER_PASSES_UNGATED_ROUTE, roles: ['viewer'] },
  { id: 'EXTENSION_ROUTE_WITHOUT_ROLE_GATE', routes: EXTENSION_ROUTE_WITHOUT_ROLE_GATE, roles: ['viewer'] },
  { id: 'OWNER_ONLY', routes: OWNER_ONLY, roles: ['admin'] },
  { id: 'VIEWER_ATTESTS_BY_POLICY', routes: VIEWER_ATTESTS_BY_POLICY, roles: ['viewer'] },
  { id: 'OWN_AGENT_KEYS', routes: OWN_AGENT_KEYS, roles: ['viewer', 'invoicer'] },
]

/** Does a route key ('POST /api/x/:id') match a concrete request? A :param matches any one segment. */
function routeKeyMatches(key: string, method: string, segments: readonly string[]): boolean {
  const space = key.indexOf(' ')
  if (key.slice(0, space) !== method) return false
  const pattern = key.slice(space + 1).split('/').filter(Boolean)
  if (pattern.length !== segments.length) return false
  return pattern.every((want, i) => want.startsWith(':') || want === segments[i])
}

/**
 * The documented exception a request falls under for the role, or null.
 * Takes the concrete method and path; a route key's :param matches any one
 * segment.
 */
export function presetExceptionFor(method: string, pathname: string, role: string): PresetException | null {
  const upper = method.toUpperCase()
  const segments = pathname.split('/').filter(Boolean)
  for (const exception of PRESET_EXCEPTIONS) {
    if (!(exception.roles as readonly string[]).includes(role)) continue
    if (exception.routes.some((key) => routeKeyMatches(key, upper, segments))) return exception.id
  }
  return null
}
