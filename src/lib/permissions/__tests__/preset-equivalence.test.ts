/**
 * Preset equivalence: the role presets reproduce today's gates. For every
 * dashboard write route the door catalog gives a permission, and for every
 * role, "the role's preset holds the permission" equals "today's gate lets
 * the role through", except for the routes listed below, each with the
 * reason the preset cannot (or should not) say the same.
 *
 * Today's gate is read from the route itself: withRouteContext's
 * requireAdmin / requireWrite / neither, an extension route's declared
 * requireAdmin / requireWrite at the dispatcher, the invoicer allowlist
 * (INVOICER_ROUTES), and HAND_ROLLED_GATES for routes that check a role in
 * their handler. A route whose gate cannot be read and is not in
 * HAND_ROLLED_GATES fails the test, so a new route gets a decision.
 *
 * The exception lists are exact: a route that stops disagreeing fails as
 * stale, so the list only shrinks when today's gates and the presets meet.
 */
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { INVOICER_ROUTES } from '@/lib/auth/invoicer-role'
import { FIRST_PARTY_EXTENSIONS } from '@/lib/extensions/_generated/extension-list'
import { SESSION_ROUTE_PARITY } from '@/lib/operations/session-route-parity'
import type { CompanyRole } from '@/types'
import { isOutsideDoor, sessionRouteDoor, type DoorClass } from '../doors'
import { presetHas } from '../presets'

const ROLES: readonly CompanyRole[] = ['owner', 'admin', 'member', 'viewer', 'invoicer']
const API_ROOT = path.resolve(__dirname, '../../../app/api')
const EXT_PREFIX = '/api/extensions/ext/'

/**
 * A route's gate today:
 *   none    withRouteContext with no role option: every role (the invoicer by its allowlist)
 *   write   requireWrite: every role but the viewer (the invoicer by its allowlist)
 *   admin   requireAdmin: owner and admin
 *   owner   the owner only
 *   reader  every role but the invoicer, whatever its allowlist
 *   all     every role, the invoicer included
 */
type Gate = 'none' | 'write' | 'admin' | 'owner' | 'reader' | 'all'

/** Routes whose handler checks a role itself, or whose wrapper the parser cannot read. */
const HAND_ROLLED_GATES: Readonly<Record<string, Gate>> = {
  // The assistant: requireAuth and a membership; the handler refuses only the invoicer.
  'POST /api/agent/ask': 'reader',
  'POST /api/agent/invoke': 'reader',
  // The assistant's onboarding pipeline writes agent_profiles: the handler refuses viewer and invoicer.
  'POST /api/agent/onboarding/stream': 'write',
  // withRouteContext without a role option; the handler refuses a viewer.
  'PATCH /api/agent/profile': 'write',
  'POST /api/agent/profile/verify': 'write',
  // The handler refuses everyone but the owner.
  'POST /api/company/:id/delete': 'owner',
  // Bank payment packs charge the company's card: the handler refuses everyone but the owner.
  'POST /api/billing/payment-packs': 'owner',
  // requireWrite at the route; reset_company_for_migration refuses everyone but the owner.
  'POST /api/company/:id/migration-reset': 'owner',
  // requireWrite at the route; the handler (or loadInviteForManagement) asks for owner or admin.
  'DELETE /api/company/members/:id': 'admin',
  'POST /api/company/members/invite': 'admin',
  'POST /api/company/members/invite/:id': 'admin',
  'DELETE /api/company/members/invite/:id': 'admin',
  // requireWrite at the route; minting a key asks for owner or admin in the handler.
  'POST /api/settings/api-keys': 'admin',
  // requireWrite at the route; invoice_payee_defaults' RLS write policy is user_is_company_admin.
  'PUT /api/cash-accounts/payee-defaults': 'admin',
  // The consent page: any member connects, the scopes capped by role (capScopesForRole).
  'POST /api/mcp-oauth/authorize': 'all',
  // registerParseRoute wraps withRouteContext with no role option.
  'POST /api/import/customers/parse': 'none',
  'POST /api/import/suppliers/parse': 'none',
  'POST /api/import/articles/parse': 'none',
  // Extension handlers that check the role the dispatcher does not.
  'POST /api/extensions/ext/email/sending-domain': 'admin',
  'PATCH /api/extensions/ext/email/sending-domain': 'admin',
  'DELETE /api/extensions/ext/email/sending-domain': 'admin',
  'POST /api/extensions/ext/email/sending-domain/verify': 'admin',
  'POST /api/extensions/ext/invoice-inbox/inbox/rotate': 'admin',
  'POST /api/extensions/ext/invoice-inbox/inbox/previous/stop': 'admin',
  'POST /api/extensions/ext/mail/oauth/start': 'write',
  'POST /api/extensions/ext/arcim-migration/invoice-completion/retry': 'write',
  // Acting at Skatteverket: requireSkvWriteRole refuses viewer and invoicer
  // (the skatteverket extension's write-role-gate.test.ts derives the set).
  'POST /api/extensions/ext/skatteverket/declaration/draft': 'write',
  'DELETE /api/extensions/ext/skatteverket/declaration/draft': 'write',
  'PUT /api/extensions/ext/skatteverket/declaration/lock': 'write',
  'DELETE /api/extensions/ext/skatteverket/declaration/lock': 'write',
  'POST /api/extensions/ext/skatteverket/declaration/submit': 'write',
  'POST /api/extensions/ext/skatteverket/agi/submit': 'write',
  'POST /api/extensions/ext/skatteverket/agi/send-for-signing': 'write',
  'POST /api/extensions/ext/skatteverket/agi/granskningsunderlag': 'write',
  'POST /api/extensions/ext/skatteverket/agi/lasUpp': 'write',
  'DELETE /api/extensions/ext/skatteverket/system-connection': 'write',
  'POST /api/extensions/ext/skatteverket/system-connection/deeplink': 'write',
  'POST /api/extensions/ext/skatteverket/system-connection/verify': 'write',
}

// ── Exceptions: where the preset and today's gate disagree ──────────────

/**
 * The invoicer role is a route allowlist (INVOICER_ROUTES), narrower than
 * the invoicing permission its preset holds: these invoicing routes are
 * refused to it today and stay refused by the allowlist, which
 * withRouteContext keeps applying beside the permission.
 */
const INVOICER_OUTSIDE_ALLOWLIST: readonly string[] = [
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
const VIEWER_PASSES_UNGATED_ROUTE: readonly string[] = [
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
const EXTENSION_ROUTE_WITHOUT_ROLE_GATE: readonly string[] = [
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
const OWNER_ONLY: readonly string[] = [
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
const OWN_AGENT_KEYS: readonly string[] = [
  'DELETE /api/settings/api-keys/:id',
  'PATCH /api/settings/api-keys/:id',
]

const EXCEPTIONS: ReadonlyArray<{ routes: readonly string[]; roles: readonly CompanyRole[] }> = [
  { routes: INVOICER_OUTSIDE_ALLOWLIST, roles: ['invoicer'] },
  { routes: VIEWER_PASSES_UNGATED_ROUTE, roles: ['viewer'] },
  { routes: EXTENSION_ROUTE_WITHOUT_ROLE_GATE, roles: ['viewer'] },
  { routes: OWNER_ONLY, roles: ['admin'] },
  { routes: OWN_AGENT_KEYS, roles: ['viewer', 'invoicer'] },
]

// ── Reading today's gate ────────────────────────────────────────────────

/** Route files by their route key path (/api/invoices/:id/convert). */
function routeFiles(dir = API_ROOT, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'v1' && dir === API_ROOT) continue
      routeFiles(full, out)
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      const segments = path
        .relative(API_ROOT, path.dirname(full))
        .split(path.sep)
        .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
        .map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*').replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1'))
      out.set('/api/' + segments.join('/'), full)
    }
  }
  return out
}

/** The gate of one method's export in a route file, or null when it is not a withRouteContext export. */
function fileGate(source: string, method: string): Gate | null {
  const start = new RegExp(`^[ \\t]*export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`, 'm').exec(source)
  if (!start) return null
  const rest = source.slice(start.index)
  const next = rest.slice(1).search(/^[ \t]*export\s/m)
  // Comments out: a comment may name the option it explains not taking.
  const block = (next === -1 ? rest : rest.slice(0, next + 1)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  if (!/withRouteContext\b/.test(block)) return null
  if (/requireAdmin:\s*true/.test(block)) return 'admin'
  if (/requireWrite:\s*true/.test(block)) return 'write'
  return 'none'
}

const files = routeFiles()
const extensionRoutes = new Map<string, { requireAdmin: boolean; requireWrite: boolean }>()
for (const extension of FIRST_PARTY_EXTENSIONS) {
  for (const route of extension.apiRoutes ?? []) {
    extensionRoutes.set(`${route.method} ${EXT_PREFIX}${extension.id}${route.path}`, {
      requireAdmin: 'requireAdmin' in route && route.requireAdmin === true,
      requireWrite: 'requireWrite' in route && route.requireWrite === true,
    })
  }
}
const loadedExtensionIds = new Set(FIRST_PARTY_EXTENSIONS.map((e) => e.id))

function extensionIdOf(key: string): string | null {
  const routePath = key.slice(key.indexOf(' ') + 1)
  return routePath.startsWith(EXT_PREFIX) ? routePath.slice(EXT_PREFIX.length).split('/')[0] : null
}

/** Today's gate of a route, or undefined when it cannot be read here (an extension this build does not load). */
function todayGate(key: string): Gate | null | undefined {
  const extensionId = extensionIdOf(key)
  if (extensionId && !loadedExtensionIds.has(extensionId)) return undefined
  if (Object.hasOwn(HAND_ROLLED_GATES, key)) return HAND_ROLLED_GATES[key]
  if (extensionId) {
    const route = extensionRoutes.get(key)
    if (!route) return null
    return route.requireAdmin ? 'admin' : route.requireWrite ? 'write' : 'none'
  }
  const [method, routePath] = key.split(' ')
  const file = files.get(routePath)
  return file ? fileGate(readFileSync(file, 'utf8'), method) : null
}

/** Is the route on the invoicer allowlist? Its keys write every path parameter as [id]. */
function invoicerAllowlisted(key: string): boolean {
  return Object.hasOwn(INVOICER_ROUTES, key.replace(/:[A-Za-z_]+/g, '[id]'))
}

/**
 * Does today's gate let the role through? The invoicer by the allowlist on
 * every route, extension routes included: the extension dispatcher applies
 * it too since W0, so the allowlist is the rule compared.
 */
function todayAllows(gate: Gate, role: CompanyRole, key: string): boolean {
  if (role === 'invoicer') {
    if (gate === 'all') return true
    if (gate === 'none' || gate === 'write') return invoicerAllowlisted(key)
    return false
  }
  switch (gate) {
    case 'none':
    case 'reader':
    case 'all':
      return true
    case 'write':
      return role !== 'viewer'
    case 'admin':
      return role === 'owner' || role === 'admin'
    case 'owner':
      return role === 'owner'
  }
}

function presetAllows(door: DoorClass, role: CompanyRole): boolean {
  return presetHas(role, door.permission) || (door.orPermission !== undefined && presetHas(role, door.orPermission))
}

const permissionRoutes = Object.entries(SESSION_ROUTE_PARITY)
  .filter(([, entry]) => entry.status !== 'machine')
  .map(([key]) => key)
  .flatMap((key) => {
    const door = sessionRouteDoor(key)
    return door && !isOutsideDoor(door) ? [{ key, door }] : []
  })

describe('preset equivalence with the route gates of today', () => {
  it('reads a gate for every route the door catalog gives a permission', () => {
    const unread = permissionRoutes.filter(({ key }) => todayGate(key) === null).map(({ key }) => key)
    expect(
      unread,
      'A route whose role check the test cannot read: add its gate to HAND_ROLLED_GATES with the reason.',
    ).toEqual([])
  })

  it('names only live routes in HAND_ROLLED_GATES', () => {
    const live = new Set(permissionRoutes.map(({ key }) => key))
    const stale = Object.keys(HAND_ROLLED_GATES).filter((key) => {
      const extensionId = extensionIdOf(key)
      return !live.has(key) && (extensionId === null || loadedExtensionIds.has(extensionId))
    })
    expect(stale).toEqual([])
  })

  it('agrees with every gate for every role, but for the listed exceptions', () => {
    const expected = new Map<string, Set<CompanyRole>>()
    for (const { routes, roles } of EXCEPTIONS) {
      for (const key of routes) {
        const extensionId = extensionIdOf(key)
        if (extensionId && !loadedExtensionIds.has(extensionId)) continue
        const set = expected.get(key) ?? new Set<CompanyRole>()
        for (const role of roles) set.add(role)
        expected.set(key, set)
      }
    }
    const actual = new Map<string, Set<CompanyRole>>()
    for (const { key, door } of permissionRoutes) {
      const gate = todayGate(key)
      if (!gate) continue
      for (const role of ROLES) {
        if (presetAllows(door, role) === todayAllows(gate, role, key)) continue
        const set = actual.get(key) ?? new Set<CompanyRole>()
        set.add(role)
        actual.set(key, set)
      }
    }
    const show = (map: Map<string, Set<CompanyRole>>) =>
      [...map].map(([key, roles]) => `${key} [${[...roles].sort().join(', ')}]`).sort()
    expect(show(actual), 'the preset and the gate of today disagree: fix the door, or list the route as an exception with its reason').toEqual(
      show(expected),
    )
  })
})
