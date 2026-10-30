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
  'DELETE /api/invoices/recurring/:id',
  'DELETE /api/settings/invoice-font',
  'DELETE /api/settings/logo',
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
  'POST /api/invoices/:id/finalize',
  'POST /api/invoices/:id/link-to-voucher',
  'POST /api/invoices/:id/mark-paid',
  'POST /api/invoices/:id/mark-sent',
  'POST /api/invoices/:id/peppol',
  'POST /api/invoices/:id/peppol/send',
  'POST /api/invoices/:id/refresh-exchange-rate',
  'POST /api/invoices/:id/resend',
  'POST /api/invoices/:id/send-payment-confirmation',
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
  'POST /api/settings/invoice-font',
  'POST /api/settings/logo',
  'POST /api/webshop-orders/:id/create-invoice',
  'PUT /api/invoices/autogiro/settings',
]

/**
 * Dashboard write routes that check no role today (withRouteContext without
 * requireWrite), so a viewer reaches the handler. The permission is the rule
 * the door enforces from W2b on, as W0 already did for the Arkiv revert and
 * finding routes (requireWrite).
 */
export const VIEWER_PASSES_UNGATED_ROUTE: readonly string[] = [
  'POST /api/documents/:id/extraction/fields',
  'POST /api/parties/aliases',
]

/**
 * Extension routes the dispatcher declares no role gate for and whose
 * handler checks none, so a viewer reaches the handler. The permission is
 * the rule the door enforces from W2b on; whether the database refused the
 * viewer's write before depends on each table's RLS (current_user_can_write)
 * and on whether the effect lands outside the database at all.
 */
export const EXTENSION_ROUTE_WITHOUT_ROLE_GATE: readonly string[] = [
  'DELETE /api/extensions/ext/arcim-migration/disconnect',
  'DELETE /api/extensions/ext/enable-banking/disconnect',
  'DELETE /api/extensions/ext/invoice-inbox/items/:id',
  'DELETE /api/extensions/ext/shopify/disconnect',
  'DELETE /api/extensions/ext/stripe/disconnect',
  'DELETE /api/extensions/ext/woocommerce/disconnect',
  'DELETE /api/extensions/ext/zettle/disconnect',
  'PATCH /api/extensions/ext/enable-banking/accounts',
  'PATCH /api/extensions/ext/invoice-inbox/items/:id/fields',
  'PATCH /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/ignore',
  'POST /api/extensions/ext/arcim-migration/accept',
  'POST /api/extensions/ext/arcim-migration/connect',
  'POST /api/extensions/ext/arcim-migration/import-documents',
  'POST /api/extensions/ext/arcim-migration/import-sie',
  'POST /api/extensions/ext/arcim-migration/migrate',
  'POST /api/extensions/ext/arcim-migration/migration-jobs',
  'POST /api/extensions/ext/arcim-migration/migration-jobs/accept',
  'POST /api/extensions/ext/arcim-migration/migration-jobs/retry',
  'POST /api/extensions/ext/arcim-migration/migration-jobs/run',
  'POST /api/extensions/ext/arcim-migration/reconcile',
  'POST /api/extensions/ext/arcim-migration/submit-token',
  'POST /api/extensions/ext/cloud-backup/connect',
  'POST /api/extensions/ext/cloud-backup/disconnect',
  'POST /api/extensions/ext/cloud-backup/sync',
  'POST /api/extensions/ext/enable-banking/attach',
  'POST /api/extensions/ext/enable-banking/connect',
  'POST /api/extensions/ext/invoice-inbox/items/:id/book-direct',
  'POST /api/extensions/ext/invoice-inbox/items/:id/convert',
  'POST /api/extensions/ext/invoice-inbox/items/:id/match-transaction',
  'POST /api/extensions/ext/invoice-inbox/items/:id/retry-extraction',
  'POST /api/extensions/ext/invoice-inbox/items/:id/unmatch-transaction',
  'POST /api/extensions/ext/invoice-inbox/items/bulk-book',
  'POST /api/extensions/ext/invoice-inbox/upload',
  'POST /api/extensions/ext/invoice-inbox/upload/complete',
  'POST /api/extensions/ext/invoice-inbox/upload/create',
  'POST /api/extensions/ext/shopify/backfill',
  'POST /api/extensions/ext/shopify/connect',
  'POST /api/extensions/ext/shopify/sync',
  'POST /api/extensions/ext/shopify/transaction-sync',
  'POST /api/extensions/ext/skatteverket/disconnect',
  'POST /api/extensions/ext/skatteverket/skattekonto/sync',
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/bokfor',
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/match',
  'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch',
  'POST /api/extensions/ext/stripe/backfill',
  'POST /api/extensions/ext/stripe/connect',
  'POST /api/extensions/ext/stripe/sync',
  'POST /api/extensions/ext/stripe/transaction-sync',
  'POST /api/extensions/ext/woocommerce/backfill',
  'POST /api/extensions/ext/woocommerce/connect',
  'POST /api/extensions/ext/woocommerce/manual-connect',
  'POST /api/extensions/ext/woocommerce/sync',
  'POST /api/extensions/ext/woocommerce/transaction-sync',
  'POST /api/extensions/ext/zettle/backfill',
  'POST /api/extensions/ext/zettle/connect',
  'POST /api/extensions/ext/zettle/sync',
  'POST /api/extensions/ext/zettle/transaction-sync',
  'PUT /api/extensions/ext/cloud-backup/schedule',
]

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

export type PresetException =
  | 'INVOICER_OUTSIDE_ALLOWLIST'
  | 'VIEWER_PASSES_UNGATED_ROUTE'
  | 'EXTENSION_ROUTE_WITHOUT_ROLE_GATE'
  | 'OWNER_ONLY'
  | 'OWN_AGENT_KEYS'

export const PRESET_EXCEPTIONS: ReadonlyArray<{
  id: PresetException
  routes: readonly string[]
  roles: readonly CompanyRole[]
}> = [
  { id: 'INVOICER_OUTSIDE_ALLOWLIST', routes: INVOICER_OUTSIDE_ALLOWLIST, roles: ['invoicer'] },
  { id: 'VIEWER_PASSES_UNGATED_ROUTE', routes: VIEWER_PASSES_UNGATED_ROUTE, roles: ['viewer'] },
  { id: 'EXTENSION_ROUTE_WITHOUT_ROLE_GATE', routes: EXTENSION_ROUTE_WITHOUT_ROLE_GATE, roles: ['viewer'] },
  { id: 'OWNER_ONLY', routes: OWNER_ONLY, roles: ['admin'] },
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
