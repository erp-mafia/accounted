/**
 * The invoicing-only company role: `invoicer`, shown as "Fakturering".
 *
 * Someone who makes quotes and invoices but must not see payroll, the ledger
 * or the bank (crm#1014, accounted#39). Hiding payroll from a member cannot
 * hold: a salary voucher is an ordinary verifikat and the bank feed shows each
 * net salary. So the role starts from nothing and is given back only what
 * invoicing needs. Decision: docs/decisions/2026-10/2026-10-27-invoicer-role.md.
 *
 * The enforcement, layer by layer:
 *   - Database (20261027130000_invoicer_company_role): the shared membership
 *     checks leave the role out, so its own session reads nothing but the
 *     invoicing tables and writes nothing at all.
 *   - Web routes (withRouteContext): a route outside INVOICER_ROUTES is
 *     refused with 403. A `scoped` route runs its handler with a
 *     company-scoped service client (lib/auth/company-scoped-client.ts): the
 *     writes, sending and the voucher it books. A `session` route keeps the
 *     user's own session, so RLS decides what it returns. These routes rely
 *     on these code checks, not on the database.
 *   - Pages (dashboard layout): a page outside INVOICER_PAGES redirects to
 *     INVOICER_HOME, and the menu shows only those pages. Next renders a page
 *     in parallel with its layout, and a client navigation does not render
 *     the layout at all, so a page whose own server reads go through the
 *     user's session also redirects first (redirectInvoicerOffPage in the
 *     dashboard's request-context.ts).
 *   - API keys and MCP: only INVOICER_API_SCOPES (with-api-v1 company gate,
 *     MCP company routing, the portfolio scope).
 *
 * Pure data and matchers, no server imports: the menu bundles it.
 * __tests__/invoicer-role.test.ts pins every list, so a route or page joins
 * only through a reviewed edit of that test.
 */
import type { ApiKeyScope } from '@/lib/auth/scope-catalog'
import type { CompanyRole } from '@/types'

export const INVOICER_ROLE = 'invoicer' satisfies CompanyRole

export function isInvoicerRole(role: string | null | undefined): boolean {
  return role === INVOICER_ROLE
}

/**
 * Roles that keep the books: they may write anywhere the company is open to
 * writes. Viewer reads everything and writes nothing; invoicer reaches only
 * the invoicing area. Use it wherever a list of people who may act on the
 * books is built; who may attest is isAttestRole.
 */
export function isBookkeepingWriterRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member'
}

/**
 * Roles whose attest of a supplier invoice counts where the company's attest
 * policy names them: those who keep the books, and viewer, who can say yes or
 * no to paying an invoice and change nothing else (a byrå's client who only
 * reads the books, crm#1569). An invoice no policy governs is still attested
 * only by isBookkeepingWriterRole, the one click it was before the policy;
 * invoicer never attests. The database's supplier_invoice_attest_ruling
 * holds the same roles.
 */
export function isAttestRole(role: string | null | undefined): boolean {
  return isBookkeepingWriterRole(role) || role === 'viewer'
}

/** The API key and MCP scopes an invoicer membership may use: customers, invoices (quotes and orders included) and articles. */
export const INVOICER_API_SCOPES: readonly ApiKeyScope[] = [
  'customers:read',
  'customers:write',
  'invoices:read',
  'invoices:draft',
  'invoices:write',
  'articles:read',
  'articles:write',
]

/**
 * May a membership with this role use a door that requires `scope`?
 * Every role but invoicer may (the key's own scopes still apply). An
 * invoicer may only use the INVOICER_API_SCOPES; a door with no scope or
 * one that only needs any valid key ('authenticated') is refused, since
 * neither says it stays inside the invoicing area.
 */
export function roleAllowsScope(
  role: string | null | undefined,
  scope: ApiKeyScope | 'authenticated' | undefined,
): boolean {
  if (!isInvoicerRole(role)) return true
  return scope !== undefined && scope !== 'authenticated' && INVOICER_API_SCOPES.includes(scope)
}

/** How an invoicer reaches an allowed web route. */
export type InvoicerRouteAccess = 'scoped' | 'session'

/**
 * Every dashboard API route an invoicer may call, as `METHOD /api/path`
 * with `[id]` for a uuid path segment.
 *
 * `scoped`: the handler gets a company-scoped service client, because the
 * route writes (the role writes nothing through its own session) or books
 * the invoice's voucher through the engine when sending.
 * `session`: a read; the handler keeps the user's session and RLS returns
 * only the invoicing tables.
 */
export const INVOICER_ROUTES: Readonly<Record<string, InvoicerRouteAccess>> = {
  'GET /api/invoices': 'session',
  'POST /api/invoices': 'scoped',
  'PATCH /api/invoices/[id]': 'scoped',
  'DELETE /api/invoices/[id]': 'scoped',
  'POST /api/invoices/[id]/send': 'scoped',
  // Numbers a draft the role saved: what POST /api/invoices does when it
  // creates the invoice numbered. Books nothing.
  'POST /api/invoices/[id]/finalize': 'scoped',
  // Issues without sending: books what send books, never more. The route
  // refuses the role paid_at_issue, which would also register a payment.
  'POST /api/invoices/[id]/mark-sent': 'scoped',
  // The delivery history (masked recipients). The definer reader admits any
  // member of the company by its own session.
  'GET /api/invoices/[id]/deliveries': 'session',
  // The archived PDF of a delivery of this invoice, and nothing else in the
  // document archive (/api/documents stays closed).
  'GET /api/invoices/[id]/archived-pdf': 'scoped',
  'POST /api/invoices/[id]/convert': 'scoped',
  'POST /api/invoices/[id]/convert-to-order': 'scoped',
  'POST /api/invoices/[id]/quote-status': 'scoped',
  'GET /api/invoices/[id]/pdf': 'scoped',
  'POST /api/invoices/preview-pdf': 'scoped',
  'POST /api/invoices/preview-email': 'scoped',
  'GET /api/invoices/next-number': 'scoped',
  'GET /api/customers': 'session',
  'POST /api/customers': 'scoped',
  'GET /api/customers/[id]': 'session',
  'PATCH /api/customers/[id]': 'scoped',
  'DELETE /api/customers/[id]': 'scoped',
  'GET /api/articles': 'session',
  'POST /api/articles': 'scoped',
  'GET /api/articles/[id]': 'session',
  'PATCH /api/articles/[id]': 'scoped',
  'DELETE /api/articles/[id]': 'scoped',
  'GET /api/sales-orders': 'session',
  'POST /api/sales-orders': 'scoped',
  'GET /api/sales-orders/[id]': 'session',
  'PATCH /api/sales-orders/[id]': 'scoped',
  'DELETE /api/sales-orders/[id]': 'scoped',
  'POST /api/sales-orders/[id]/transition': 'scoped',
  'POST /api/sales-orders/[id]/create-invoice': 'scoped',
  'GET /api/settings': 'session',
  'POST /api/vat/validate': 'session',
  'GET /api/currency/rate': 'session',
}

/** Where an invoicer lands, and where a page outside INVOICER_PAGES sends them. */
export const INVOICER_HOME = '/invoices'

/** Every dashboard page an invoicer may open, `[id]` for a uuid path segment. */
export const INVOICER_PAGES: readonly string[] = [
  '/invoices',
  '/invoices/new',
  '/invoices/[id]',
  '/invoices/[id]/edit',
  '/quotes',
  '/customers',
  '/customers/[id]',
  '/articles',
  '/articles/[id]',
  '/sales-orders',
  '/sales-orders/new',
  '/sales-orders/[id]',
  '/sales-orders/[id]/edit',
  '/settings/account',
]

const UUID_SEGMENT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('[id]')
    .map((part) => part.replace(/[.*+?^${}()|\\]/g, '\\$&'))
    .join(UUID_SEGMENT)
  return new RegExp(`^${escaped}/?$`)
}

const ROUTE_MATCHERS = Object.entries(INVOICER_ROUTES).map(([key, access]) => {
  const [method, path] = key.split(' ')
  return { method, regexp: patternToRegExp(path), access }
})

const PAGE_MATCHERS = INVOICER_PAGES.map(patternToRegExp)

/** How an invoicer may reach this request, or null when the route is outside the allowlist. */
export function invoicerRouteAccess(method: string, pathname: string): InvoicerRouteAccess | null {
  const upper = method.toUpperCase()
  const match = ROUTE_MATCHERS.find((m) => m.method === upper && m.regexp.test(pathname))
  return match ? match.access : null
}

/** May an invoicer open this dashboard page? */
export function isInvoicerPagePath(pathname: string): boolean {
  return PAGE_MATCHERS.some((regexp) => regexp.test(pathname))
}

/**
 * Where a dashboard render sends a member with this role in the active
 * company: INVOICER_HOME for an invoicer on a page outside INVOICER_PAGES,
 * otherwise null (the page renders). An empty or unknown path counts as
 * outside, so a lost pathname sends an invoicer home, never further in.
 */
export function invoicerPageRedirect(role: string | null | undefined, pathname: string): string | null {
  return isInvoicerRole(role) && !isInvoicerPagePath(pathname) ? INVOICER_HOME : null
}
