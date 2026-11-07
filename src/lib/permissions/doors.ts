/**
 * Doors: which permission (./catalog.ts) each way into a company's data
 * needs, what kind of change it makes, and whether it can stage.
 *
 *   effect
 *     ledger        creates or changes bookkeeping: vouchers, invoices sent,
 *                   payments, filings, periods
 *     record        registers and settings: customers, articles, accounts,
 *                   dimensions, employees, company settings, members
 *     housekeeping  changes no books: uploads, bank sync, agent memory,
 *                   feedback, previews kept, links between documents
 *     read          reads, and POSTs that only compute or preview
 *   stageable       the door can hand the write to a person as a pending
 *                   operation instead of committing it
 *
 * ./decide.ts reads the class: a person needs the permission; an agent at
 * `propose` reads and keeps house freely, stages ledger and record writes
 * where the door can stage and is refused where it cannot.
 *
 * The doors, each classified exactly once (__tests__/doors.test.ts fails on
 * an unclassified door and on a stale entry):
 *   - session routes: SESSION_DOOR_RULES, by path prefix and method, the
 *     longest match winning;
 *   - operations (lib/operations): their API scope's default, or an entry
 *     in OPERATION_DOORS; their v1 endpoint, generated MCP tool and pending
 *     type at approval follow the operation;
 *   - hand-written v1 endpoints: their scope's default, or V1_DOORS;
 *   - pending types no operation stages: PENDING_TYPE_DOORS;
 *   - hand-written MCP tools: classified inside the MCP extension
 *     (src/extensions/general/mcp-server/permission-doors.ts), from the
 *     same scope defaults, since core never imports an extension.
 *
 * A door no company permission governs (a person's own account, a byrå's
 * team, a link authenticated by its token, an approval decided per staged
 * operation) is an OutsideDoor with its reason.
 *
 * Pure data and matchers, no server imports, like lib/modules/package-doors.ts:
 * every door may read it on every request.
 */
import { API_KEY_SCOPES, type ApiKeyScope } from '@/lib/auth/scope-catalog'
import type { Permission } from './catalog'

export type DoorEffect = 'ledger' | 'record' | 'housekeeping' | 'read'

export interface DoorClass {
  /** What a person needs, and the permission whose mandate an agent acts at. */
  readonly permission: Permission
  /** A second permission that opens the same door: invoicing reads, which the bookkeeper and the invoicer both make. */
  readonly orPermission?: Permission
  readonly effect: DoorEffect
  readonly stageable: boolean
}

/**
 * Why no company permission governs a door:
 *   personal     the person's own account, preferences, consent or chat
 *   team         the byrå's own team, brand and client list
 *   link         a link authenticated by its token (signatory, attester, signer)
 *   platform     Accounted staff review
 *   new-company  creating a company, before any membership exists
 *   approval     approving or rejecting a staged operation: decided per
 *                operation by its pending type (pendingTypeDoor)
 *   public       no tenant data at all
 *   bridge       carries another tool, whose own door is decided
 */
export type OutsideReason =
  | 'personal'
  | 'team'
  | 'link'
  | 'platform'
  | 'new-company'
  | 'approval'
  | 'public'
  | 'bridge'

export interface OutsideDoor {
  readonly outside: OutsideReason
}

export type DoorRule = DoorClass | OutsideDoor

/** A door class before its staging is known: the scope defaults and the override tables. */
export type DoorSpec = Omit<DoorClass, 'stageable'>

export function isOutsideDoor(rule: DoorRule | DoorSpec | OutsideDoor): rule is OutsideDoor {
  return 'outside' in rule
}

const spec = (permission: Permission, effect: DoorEffect, orPermission?: Permission): DoorSpec =>
  Object.freeze(orPermission ? { permission, orPermission, effect } : { permission, effect })
const outside = (reason: OutsideReason): OutsideDoor => Object.freeze({ outside: reason })

// ── The door classes in use ───────────────────────────────────────────

const READ = spec('bookkeeping.read', 'read')
/** Anyone who reads the books may do it: the assistant, billing, a viewer's own bank sync. */
const READER_HOUSE = spec('bookkeeping.read', 'housekeeping')
const BOOK = spec('bookkeeping.write', 'ledger')
const BOOK_RECORD = spec('bookkeeping.write', 'record')
const BOOK_HOUSE = spec('bookkeeping.write', 'housekeeping')
const INVOICING = spec('invoicing', 'ledger')
const INVOICING_RECORD = spec('invoicing', 'record')
const INVOICING_READ = spec('bookkeeping.read', 'read', 'invoicing')
const PAYMENTS = spec('payments.prepare', 'ledger')
const PAYMENTS_RECORD = spec('payments.prepare', 'record')
const PAYMENTS_READ = spec('payments.prepare', 'read')
const PAYROLL = spec('payroll.write', 'ledger')
const PAYROLL_RECORD = spec('payroll.write', 'record')
const PAYROLL_HOUSE = spec('payroll.write', 'housekeeping')
const PAYROLL_READ = spec('payroll.read', 'read')
const TAX = spec('tax.prepare', 'ledger')
const TAX_RECORD = spec('tax.prepare', 'record')
const PERIODS = spec('periods', 'ledger')
const PERIODS_RECORD = spec('periods', 'record')
const SETTINGS = spec('settings', 'record')
const SETTINGS_LEDGER = spec('settings', 'ledger')
const MEMBERS = spec('members', 'record')
const CONNECT = spec('agents.connect', 'housekeeping')
const AUTONOMY = spec('agents.autonomy', 'record')

/** The classes, for the MCP extension's override table. */
export const DOOR_SPECS = Object.freeze({
  READ,
  READER_HOUSE,
  BOOK,
  BOOK_RECORD,
  BOOK_HOUSE,
  INVOICING,
  INVOICING_RECORD,
  INVOICING_READ,
  PAYMENTS,
  PAYMENTS_RECORD,
  PAYROLL,
  PAYROLL_RECORD,
  PAYROLL_HOUSE,
  PAYROLL_READ,
  TAX,
  PERIODS,
  SETTINGS,
  MEMBERS,
  AUTONOMY,
  CONNECT,
})

export const OUTSIDE = Object.freeze({
  personal: outside('personal'),
  team: outside('team'),
  link: outside('link'),
  platform: outside('platform'),
  newCompany: outside('new-company'),
  approval: outside('approval'),
  public: outside('public'),
  bridge: outside('bridge'),
})

// ── API scopes: the default door of an MCP tool, v1 endpoint or operation ──

/**
 * The door a scope's tools and endpoints default to. A read of a write
 * scope (GET /webhooks under webhooks:manage) keeps the permission and reads.
 * Null: no default, the door is decided elsewhere (approving decides per
 * staged operation).
 *
 * The role ceiling holds through these defaults: a viewer's preset covers
 * exactly the read scopes and an invoicer's exactly INVOICER_API_SCOPES, as
 * capScopesForRole caps them today (__tests__/presets.test.ts).
 */
export const SCOPE_DOORS: Readonly<Record<ApiKeyScope, DoorSpec | null>> = Object.freeze({
  'transactions:read': READ,
  'transactions:write': BOOK,
  'customers:read': INVOICING_READ,
  'customers:write': INVOICING_RECORD,
  'articles:read': INVOICING_READ,
  'articles:write': INVOICING_RECORD,
  'invoices:read': INVOICING_READ,
  // Creating and editing a draft is invoicing, as the write scope it narrows.
  'invoices:draft': INVOICING,
  'invoices:write': INVOICING,
  'suppliers:read': READ,
  // Registering a supplier invoice that posts nothing, as the write scope it narrows.
  'suppliers:register': BOOK,
  'suppliers:write': BOOK,
  'reports:read': READ,
  // The dimension registry: a read of the books, as under reports:read. The
  // invoicer role stays without it (no dimension page or route in its area).
  'dimensions:read': READ,
  'bookkeeping:write': BOOK,
  'payroll:read': PAYROLL_READ,
  'payroll:write': PAYROLL,
  'companies:read': READ,
  'companies:write': SETTINGS,
  'events:read': READ,
  // Webhook subscriptions are an integration's own plumbing: any member
  // manages them today, and they change no books.
  'webhooks:manage': BOOK_HOUSE,
  // Minting a non-human principal and its keys grants access: owner and admin only.
  'service_accounts:manage': MEMBERS,
  'operations:read': READ,
  'documents:read': READ,
  'documents:write': BOOK_HOUSE,
  'compliance:read': READ,
  'skatteverket:write': TAX,
  'agent:read': READ,
  'agent:write': BOOK_HOUSE,
  'pending_operations:read': READ,
  'pending_operations:approve': null,
  'reconciliation:read': READ,
  'reconciliation:write': BOOK_RECORD,
  'reconciliation:signoff': BOOK_RECORD,
  // The liquidity forecast's rows: planning data no verifikat reads, written
  // directly over v1 and MCP, never staged (decision 2026-10-28).
  'forecast:write': BOOK_HOUSE,
})

export function isApiKeyScope(value: string | null | undefined): value is ApiKeyScope {
  return typeof value === 'string' && Object.hasOwn(API_KEY_SCOPES, value)
}

/** A scope's default door spec; a read keeps the scope's permission and reads. */
export function scopeDoorSpec(scope: ApiKeyScope, read: boolean): DoorSpec | null {
  const base = SCOPE_DOORS[scope]
  if (!base) return null
  return read ? spec(base.permission, 'read', base.orPermission) : base
}

// ── Operations (lib/operations/registry.ts) ────────────────────────────

/** The fields of an operation the door reads; the registry's operations satisfy it. */
export interface OperationLike {
  readonly id: string
  readonly kind: 'read' | 'write'
  readonly scope: ApiKeyScope
  readonly mcp?: { readonly stage?: unknown } | undefined
}

/** Operations whose scope's default door is too coarse. Every key names a live operation. */
export const OPERATION_DOORS: Readonly<Record<string, DoorSpec>> = Object.freeze({
  // The annual report and its signatures: bokslut.
  'arsredovisning.create-version': PERIODS,
  'arsredovisning.request-signatures': PERIODS,
  'arsredovisning.add-signatory': PERIODS_RECORD,
  'arsredovisning.remove-signatory': PERIODS_RECORD,
  'arsredovisning.record-signature': PERIODS_RECORD,
  'arsredovisning.update-compliance': PERIODS_RECORD,
  'arsredovisning.update-narrative': PERIODS_RECORD,
  // Fiscal years: opening, closing, reopening, deleting.
  'fiscal-periods.create': PERIODS,
  'fiscal-periods.update': PERIODS,
  'fiscal-periods.delete': PERIODS,
  'fiscal-periods.close-external': PERIODS,
  'fiscal-periods.reopen-external': PERIODS,
  'fiscal-periods.unlock': PERIODS,
  'settings.update-bookkeeping-lock': PERIODS,
  // Registers of the books.
  'accounts.activate': BOOK_RECORD,
  'accounts.create': BOOK_RECORD,
  'accounts.deactivate': BOOK_RECORD,
  'accounts.delete': BOOK_RECORD,
  'accounts.update': BOOK_RECORD,
  'dimensions.create': BOOK_RECORD,
  'dimensions.update': BOOK_RECORD,
  'dimensions.delete': BOOK_RECORD,
  'dimension-rules.create': BOOK_RECORD,
  'dimension-rules.update': BOOK_RECORD,
  'dimension-rules.delete': BOOK_RECORD,
  // Budgets (accounted#134): planning data beside the books, never a
  // verifikat, so a register write; staged at low risk over MCP. Their reads
  // (budgets.list, budgets.get, reports.budget-vs-actual) keep the
  // reports:read default.
  'budgets.create': BOOK_RECORD,
  'budgets.update': BOOK_RECORD,
  'budgets.delete': BOOK_RECORD,
  'budgets.lines.upsert': BOOK_RECORD,
  'budgets.copy-actuals': BOOK_RECORD,
  'budgets.spread': BOOK_RECORD,
  // The file import writes the budget like the grid save; its dry run (the
  // v1 preview) is the same operation's.
  'budgets.import': BOOK_RECORD,
  'suppliers.create': BOOK_RECORD,
  'suppliers.update': BOOK_RECORD,
  // companies:write operations a member does in the app today (requireWrite
  // routes): cash accounts, the till and Peppol registration.
  'cash-accounts.create': BOOK_RECORD,
  'cash-accounts.update': BOOK_RECORD,
  'cash-accounts.set-primary': BOOK_RECORD,
  'pos-sales.connect': BOOK_RECORD,
  'pos-sales.disconnect': BOOK_RECORD,
  'pos-sales.update-settings': BOOK_RECORD,
  'peppol.register': BOOK_RECORD,
  'peppol.request-access': BOOK_RECORD,
  // Payroll registers.
  'employees.benefits.create': PAYROLL_RECORD,
  'employees.benefits.update': PAYROLL_RECORD,
  'employees.benefits.delete': PAYROLL_RECORD,
  'employees.delete': PAYROLL_RECORD,
  'employees.recurring-lines.create': PAYROLL_RECORD,
  'employees.recurring-lines.update': PAYROLL_RECORD,
  'employees.recurring-lines.delete': PAYROLL_RECORD,
  'employees.worked-days.upsert': PAYROLL_RECORD,
  'employees.worked-days.delete': PAYROLL_RECORD,
  // Filings and moms.
  'agi-filings.mark': TAX,
  'vat-filings.mark': TAX,
  'vat-filings.unmark': TAX,
  'vat-check-reviews.mark': TAX_RECORD,
  'vat.book-settlement': TAX,
  // Money out of the company's bank: prepared, approved, signed elsewhere.
  'payment-orders.prepare': PAYMENTS,
  'payment-orders.approve': PAYMENTS,
  'payment-orders.unapprove': PAYMENTS,
  'payment-orders.cancel': PAYMENTS,
  'payments.verification-start': PAYMENTS,
  'payment-signing-links.create': PAYMENTS,
  'supplier-payment-batches.create': PAYMENTS,
  'supplier-payment-batches.cancel': PAYMENTS,
  'supplier-payment-batches.preview': PAYMENTS_READ,
  'supplier-payment-batches.file': PAYMENTS_READ,
  'supplier-invoices.mark-bank-entered': PAYMENTS,
  'supplier-payees.confirm': PAYMENTS_RECORD,
  // The attest policy is an owner's or admin's (requireAdmin on its route).
  'supplier-invoices.attest-policy.update': SETTINGS,
  // Bolaget records any writer keeps (companies:write would make them
  // owner/admin): meetings and decisions, capital decisions, the owners'
  // K10 inputs, owner loans, agreements, securities and group links. Any
  // writer, decided 2026-10-29. The ownership and signatory registers stay
  // on the scope default (SETTINGS) and refuse a member in run().
  'corporate-meetings.create': BOOK_RECORD,
  'corporate-meetings.update': BOOK_RECORD,
  'corporate-meetings.decisions.record': BOOK_RECORD,
  'corporate-meetings.hold': BOOK_RECORD,
  'dividends.create': BOOK_RECORD,
  'capital-changes.create': BOOK_RECORD,
  'k10-inputs.set': BOOK_RECORD,
  'owner-loans.create': BOOK_RECORD,
  'owner-loans.update': BOOK_RECORD,
  'owner-loans.set-interest': BOOK_RECORD,
  'agreements.create': BOOK_RECORD,
  'agreements.update': BOOK_RECORD,
  'agreements.end': BOOK_RECORD,
  'securities.create': BOOK_RECORD,
  'securities.update': BOOK_RECORD,
  'group-links.create': BOOK_RECORD,
  'group-links.update': BOOK_RECORD,
  // Bank rows in and out of the feed, and links between documents: no books change.
  'bank-feed.start': BOOK_HOUSE,
  'bank-feed.select': BOOK_HOUSE,
  'bank-feed.restart': BOOK_HOUSE,
  'bank-feed.sync': BOOK_HOUSE,
  'bank-feed.disconnect': BOOK_HOUSE,
  'bank-feed.invite': BOOK_HOUSE,
  'pos-sales.fetch': BOOK_HOUSE,
  'skattekonto.sync': BOOK_HOUSE,
  'transactions.refresh-exchange-rate': BOOK_HOUSE,
  'transactions.attach-document': BOOK_HOUSE,
  'transactions.detach-document': BOOK_HOUSE,
})

/** An operation's door: its entry in OPERATION_DOORS, else its scope's default. Its staging comes from its MCP binding. */
export function operationDoor(op: OperationLike): DoorClass | null {
  const found = OPERATION_DOORS[op.id] ?? scopeDoorSpec(op.scope, op.kind === 'read')
  if (!found) return null
  return { ...found, stageable: op.kind === 'write' && op.mcp?.stage !== undefined }
}

// ── Hand-written v1 endpoints (withApiV1, no operation behind them) ────

/** The fields of a v1 endpoint the door reads; lib/api/v1/registry's EndpointDefinition satisfies it. */
export interface V1EndpointLike {
  readonly method: string
  readonly path: string
  readonly scope: string | null
  readonly stageSupported?: boolean
}

const V1 = '/api/v1/companies/:companyId'

/** Hand-written v1 endpoints whose scope's default is too coarse, or that no company permission governs. */
export const V1_DOORS: Readonly<Record<string, DoorSpec | OutsideDoor>> = Object.freeze({
  'GET /api/v1/api-key': OUTSIDE.personal,
  'GET /api/v1/health': OUTSIDE.public,
  'POST /api/v1/companies': OUTSIDE.newCompany,
  [`POST ${V1}/pending-operations/:id/approve`]: OUTSIDE.approval,
  [`POST ${V1}/pending-operations/:id/reject`]: OUTSIDE.approval,
  [`POST ${V1}/assets`]: BOOK_RECORD,
  [`PATCH ${V1}/assets/:id`]: BOOK_RECORD,
  [`DELETE ${V1}/assets/:id`]: BOOK_RECORD,
  [`POST ${V1}/dimensions/:id/values`]: BOOK_RECORD,
  [`PATCH ${V1}/dimensions/:id/values/:valueId`]: BOOK_RECORD,
  [`DELETE ${V1}/dimensions/:id/values/:valueId`]: BOOK_RECORD,
  [`POST ${V1}/reports/vat-declaration/filings`]: TAX,
  [`DELETE ${V1}/reports/vat-declaration/filings`]: TAX,
  [`POST ${V1}/fiscal-periods/:id/close`]: PERIODS,
  [`POST ${V1}/fiscal-periods/:id/lock`]: PERIODS,
  [`POST ${V1}/fiscal-periods/:id/year-end`]: PERIODS,
  [`POST ${V1}/imports/sie/upload`]: BOOK_HOUSE,
  [`POST ${V1}/employees`]: PAYROLL_RECORD,
  [`PATCH ${V1}/employees/:id`]: PAYROLL_RECORD,
  [`PUT ${V1}/employees/:id/absence`]: PAYROLL_RECORD,
  [`DELETE ${V1}/employees/:id/absence`]: PAYROLL_RECORD,
  [`PUT ${V1}/employees/:id/opening-balances`]: PAYROLL_RECORD,
  [`PUT ${V1}/employees/opening-balances`]: PAYROLL_RECORD,
  [`POST ${V1}/salary/premium-rules`]: PAYROLL_RECORD,
  [`PATCH ${V1}/salary/premium-rules/:id`]: PAYROLL_RECORD,
  [`DELETE ${V1}/salary/premium-rules/:id`]: PAYROLL_RECORD,
  [`PATCH ${V1}/salary/settings`]: SETTINGS,
  [`POST ${V1}/salary-runs/:id/payment-file`]: PAYMENTS,
  [`POST ${V1}/reconciliation/bank/run`]: BOOK_RECORD,
  [`DELETE ${V1}/suppliers/:id`]: BOOK_RECORD,
  [`POST ${V1}/suppliers/bulk-create`]: BOOK_RECORD,
  [`POST ${V1}/bank-connections/:connectionId/sync`]: BOOK_HOUSE,
})

/**
 * A v1 endpoint's door. An operation's endpoint is the operation's door
 * (pass it); a hand-written one is its V1_DOORS entry, else its scope's
 * default (a GET reads). Null: unclassified.
 */
export function v1EndpointDoor(endpoint: V1EndpointLike, op?: OperationLike): DoorRule | null {
  if (op) return operationDoor(op)
  const found =
    V1_DOORS[`${endpoint.method} ${endpoint.path}`] ??
    (isApiKeyScope(endpoint.scope) ? scopeDoorSpec(endpoint.scope, endpoint.method === 'GET') : null)
  if (!found) return null
  if (isOutsideDoor(found)) return found
  return { ...found, stageable: endpoint.stageSupported === true }
}

// ── Pending operation types, for the approval seam ────────────────────

/**
 * The pending types no operation stages (hand-written MCP tools, the daily
 * batches, grants): the permission an approver needs. The MCP extension's
 * test checks each tool's permission is the permission of the types it
 * stages.
 */
export const PENDING_TYPE_DOORS: Readonly<Record<string, DoorSpec>> = Object.freeze({
  create_customer: INVOICING_RECORD,
  update_customer: INVOICING_RECORD,
  create_article: INVOICING_RECORD,
  update_article: INVOICING_RECORD,
  create_sales_order: INVOICING_RECORD,
  transition_sales_order: INVOICING_RECORD,
  register_sales_order_delivery: INVOICING_RECORD,
  create_invoice: INVOICING,
  update_invoice: INVOICING,
  create_invoice_from_sales_order: INVOICING,
  create_recurring_schedule: INVOICING,
  update_recurring_schedule: INVOICING,
  convert_invoice: INVOICING,
  credit_invoice: INVOICING,
  delete_draft_invoice: INVOICING,
  send_invoice: INVOICING,
  mark_invoice_paid: INVOICING,
  mark_invoice_sent: INVOICING,
  link_invoice_voucher: INVOICING,
  link_rot_rut_payout_voucher: INVOICING,
  // The daily collections and reminder batches: an administrator approves
  // them in the web UI only (WEB_ONLY_APPROVAL_TYPES), as automatic mode is
  // an administrator's to switch on.
  collections_daily_batch: SETTINGS_LEDGER,
  reminder_daily_batch: SETTINGS_LEDGER,
  create_dimension_value: BOOK_RECORD,
  create_supplier: BOOK_RECORD,
  create_asset: BOOK_RECORD,
  update_asset: BOOK_RECORD,
  delete_asset: BOOK_RECORD,
  dispose_asset: BOOK,
  arkiv_propose_fact: BOOK_HOUSE,
  link_document_to_voucher: BOOK_HOUSE,
  link_documents_to_vouchers: BOOK_HOUSE,
  create_transaction: BOOK,
  categorize_transaction: BOOK,
  uncategorize_transaction: BOOK,
  ignore_transaction: BOOK,
  match_transaction_invoice: BOOK,
  settle_rot_rut_payout: BOOK,
  bulk_book_inbox_items: BOOK,
  book_skattekonto_row: BOOK,
  book_skattekonto_rows: BOOK,
  book_mileage_period: BOOK,
  retag_line_dimensions: BOOK,
  link_supplier_invoice_voucher: BOOK,
  approve_supplier_invoice: BOOK,
  credit_supplier_invoice: BOOK,
  create_supplier_invoice_from_inbox: BOOK,
  create_voucher: BOOK,
  correct_entry: BOOK,
  reverse_entry: BOOK,
  set_opening_balances: BOOK,
  run_currency_revaluation: BOOK,
  post_annual_depreciation: BOOK,
  import_sie: BOOK,
  explain_voucher_gap: BOOK,
  reconciliation_match: BOOK_RECORD,
  reconciliation_unmatch: BOOK_RECORD,
  reconciliation_signoff: BOOK_RECORD,
  reconciliation_residual: BOOK,
  close_period: PERIODS,
  lock_period: PERIODS,
  run_year_end: PERIODS,
  post_kontantmetod_cutoff: PERIODS,
  create_salary_run: PAYROLL,
  update_salary_run: PAYROLL,
  set_run_salary: PAYROLL,
  update_payslip_line: PAYROLL,
  book_salary_run: PAYROLL,
  generate_agi: PAYROLL,
  vacation_year_close: PAYROLL,
  create_employee: PAYROLL_RECORD,
  update_employee: PAYROLL_RECORD,
  set_employee_opening_balances: PAYROLL_RECORD,
  register_absence: PAYROLL_RECORD,
  delete_absence: PAYROLL_RECORD,
  log_mileage_trip: PAYROLL_RECORD,
  submit_vat_declaration: TAX,
  submit_agi: TAX,
  // Who may do what: decided by a person, never by an agent.
  revoke_service_account: MEMBERS,
  create_grant: AUTONOMY,
  revoke_grant: AUTONOMY,
})

/**
 * Pending types an operation stages whose approver needs another
 * permission than the staging door: anyone who writes may ask for a package
 * to be switched, an owner or admin decides (the commit's own check).
 */
export const PENDING_APPROVAL_DOORS: Readonly<Record<string, DoorSpec>> = Object.freeze({
  enable_package: SETTINGS,
  disable_package: SETTINGS,
})

/**
 * The door approving a pending operation of this type goes through: what
 * the approver needs. Pass the operation that stages the type, if any
 * (operationForPendingType). Null: unclassified.
 */
export function pendingTypeDoor(type: string, op?: OperationLike): DoorClass | null {
  const found = PENDING_APPROVAL_DOORS[type] ?? (op ? operationDoor(op) : PENDING_TYPE_DOORS[type])
  return found ? { ...found, stageable: true } : null
}

// ── Dashboard (session) routes ────────────────────────────────────────

/** A session route that stages for a person to approve rather than commit (a member asking for a package switch). */
type StagingSpec = DoorSpec & { readonly stageable: true }
const staging = (door: DoorSpec): StagingSpec => Object.freeze({ ...door, stageable: true as const })

/**
 * Session write routes by path prefix, optionally with a method: the rule
 * with the most path segments wins, a literal segment beats a `:param` one,
 * and a rule naming the method beats one that does not. Keys are a path
 * ('/api/invoices', every write method under it) or 'METHOD /api/...'.
 * Extension routes by their public path. Every route of
 * SESSION_ROUTE_PARITY but the machine endpoints resolves to one rule, and
 * every rule wins for at least one route (the guard test).
 */
export const SESSION_DOOR_RULES: Readonly<Record<string, DoorSpec | StagingSpec | OutsideDoor>> =
  Object.freeze({
    // ── The person's own account, the byrå's team, links, staff ────────
    '/api/account': OUTSIDE.personal,
    '/api/auth': OUTSIDE.personal,
    '/api/user': OUTSIDE.personal,
    '/api/legal': OUTSIDE.personal,
    '/api/notices': OUTSIDE.personal,
    '/api/kpi': OUTSIDE.personal,
    '/api/support': OUTSIDE.personal,
    '/api/sandbox': OUTSIDE.personal,
    '/api/onboarding/books': OUTSIDE.personal,
    '/api/agents/community': OUTSIDE.personal,
    'PATCH /api/agent/conversations/:id': OUTSIDE.personal,
    // The member's own BankID signing, as the signer named.
    '/api/signing': OUTSIDE.personal,
    // The person's own switch for the attest mail.
    'PUT /api/supplier-invoices/attest-policy/mail': OUTSIDE.personal,
    '/api/byra': OUTSIDE.team,
    '/api/clients': OUTSIDE.team,
    '/api/team': OUTSIDE.team,
    '/api/attest': OUTSIDE.link,
    '/api/betala': OUTSIDE.link,
    '/api/koppla': OUTSIDE.link,
    '/api/signera': OUTSIDE.link,
    // Anyone checks a signed file by its hash; it changes nothing.
    'POST /api/verifiera': OUTSIDE.public,
    '/api/community': OUTSIDE.platform,
    'POST /api/company/check-org-number': OUTSIDE.newCompany,
    'POST /api/pending-operations/:id/commit': OUTSIDE.approval,
    'POST /api/pending-operations/:id/reject': OUTSIDE.approval,
    'POST /api/pending-operations/bulk-commit': OUTSIDE.approval,
    'POST /api/pending-operations/bulk-reject': OUTSIDE.approval,
    'POST /api/agent/conversations/:id/reject-pending': OUTSIDE.approval,

    // ── The assistant and the agents' own surfaces ────────────────────
    '/api/agent': BOOK_HOUSE,
    'POST /api/agent/ask': READER_HOUSE,
    'POST /api/agent/invoke': READER_HOUSE,
    'POST /api/agent/categorize': READ,
    '/api/agent/onboarding': BOOK_RECORD,
    '/api/agent/profile': BOOK_RECORD,
    '/api/agents/knowledge': BOOK_HOUSE,
    '/api/skills': BOOK_HOUSE,
    '/api/grants': BOOK_HOUSE,
    // A member's revocation stages; an owner or admin approves it (revoke_grant).
    'POST /api/grants/:id/revoke': staging(BOOK_RECORD),
    // The company's kill switch for its rules for automatic booking.
    'POST /api/grants/pause': AUTONOMY,
    'POST /api/mcp-oauth/authorize': CONNECT,
    // Minting a manual key: owner or admin, as today.
    'POST /api/settings/api-keys': MEMBERS,
    // One's own key; a colleague's needs an owner or admin (the handler checks).
    '/api/settings/api-keys/:id': CONNECT,
    // The person's own redirect URIs for a self-hosted app's OAuth flow.
    '/api/settings/oauth-clients': OUTSIDE.personal,

    // ── The company, its members and settings ──────────────────────────
    '/api/company/:id/delete': SETTINGS,
    '/api/company/:id/migration-reset': SETTINGS,
    'PATCH /api/company/current': SETTINGS,
    // The 18.7 model choice (K3 18.3A): requireAdmin today.
    'PATCH /api/company/accounting-policies': SETTINGS,
    '/api/company/members': MEMBERS,
    'PATCH /api/onboarding/state': SETTINGS,
    'PUT /api/settings': SETTINGS,
    '/api/settings/collections': SETTINGS,
    '/api/settings/data-sharing': SETTINGS,
    '/api/settings/skattekonto-account': SETTINGS,
    'POST /api/settings/skattekonto-account/transfer-draft': PAYMENTS,
    '/api/settings/booking-templates': BOOK_RECORD,
    '/api/settings/counterparty-templates': BOOK_RECORD,
    '/api/settings/peppol': BOOK_RECORD,
    '/api/settings/logo': SETTINGS,
    '/api/settings/invoice-font': SETTINGS,
    // A member asks for a package switch; an owner or admin approves it (enable_package).
    '/api/packages': staging(BOOK_RECORD),
    '/api/billing': READER_HOUSE,
    // Bank payment packs charge the company's card: a company decision, and
    // the owner's alone (the handler checks the role).
    'POST /api/billing/payment-packs': SETTINGS,
    // Asking for more of a priced service than the month includes: any member
    // who records may ask; the founders open the charge by hand.
    'POST /api/billing/usage/requests': BOOK_RECORD,
    '/api/calendar': BOOK_HOUSE,
    '/api/deadlines': BOOK_HOUSE,
    '/api/tax-deadlines': BOOK_HOUSE,
    '/api/rules': BOOK_RECORD,
    // Hard blocks (accounted#130): which bookings no key, rule for automatic
    // booking, bulk path or one click may post. Owner or admin, like the
    // grants' kill switch; every member reads them.
    'POST /api/rules/blocks': AUTONOMY,
    'DELETE /api/rules/blocks/:ruleId': AUTONOMY,
    'PATCH /api/pending-operations/:id/items': SETTINGS_LEDGER,

    // ── Bookkeeping ────────────────────────────────────────────────────
    '/api/bookkeeping': BOOK,
    '/api/bookkeeping/accounts': BOOK_RECORD,
    'POST /api/bookkeeping/proposal-preview': READ,
    // Computes the transition vouchers and writes nothing; commit is BOOK.
    'POST /api/bookkeeping/k3-transition/preview': READ,
    '/api/bookkeeping/fiscal-periods': PERIODS,
    'POST /api/bookkeeping/fiscal-periods/:id/accruals': BOOK,
    '/api/bookkeeping/fiscal-periods/:id/depreciation': BOOK,
    'POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review': BOOK,
    // The IB review's SIE file: requireAdmin today.
    'POST /api/bookkeeping/fiscal-periods/:id/opening-balance-review/sie-file': SETTINGS_LEDGER,
    '/api/dimensions': BOOK_RECORD,
    // Budgets (accounted#134): planning data, a register write like
    // budgets.* (OPERATION_DOORS); the import's preview only reads.
    '/api/budgets': BOOK_RECORD,
    'POST /api/budgets/:id/import/preview': READ,
    'POST /api/dimensions/tagging/apply': BOOK,
    '/api/cash-accounts': BOOK_RECORD,
    // invoice_payee_defaults: its RLS write policy is owner and admin.
    'PUT /api/cash-accounts/payee-defaults': SETTINGS,
    '/api/transactions': BOOK,
    'POST /api/transactions/suggest-categories': READ,
    '/api/transactions/:id/attach-document': BOOK_HOUSE,
    'POST /api/transactions/:id/refresh-exchange-rate': BOOK_HOUSE,
    '/api/reconciliation': BOOK_RECORD,
    'POST /api/reconciliation/accounts/:accountKey/residual': BOOK,
    '/api/reconciliation/accounts/:accountKey/attachments': BOOK_HOUSE,
    'POST /api/reconciliation/bank/mark-opening-balance': BOOK,
    '/api/documents': BOOK_HOUSE,
    '/api/arkiv': BOOK_HOUSE,
    'POST /api/arkiv/facts/:id/revert': BOOK_RECORD,
    '/api/signing-requests': BOOK_HOUSE,
    '/api/receipt-hunt': BOOK_HOUSE,
    '/api/inkorg': BOOK,
    '/api/inkorg/portals': BOOK_HOUSE,
    '/api/parties': BOOK_RECORD,
    'POST /api/parties/:id/setoffs': INVOICING,
    '/api/extensions/:sector/:slug/data': BOOK_HOUSE,
    '/api/import': BOOK,
    'POST /api/import/bank-file/parse': READ,
    'POST /api/import/bank-file/check-duplicates': READ,
    // A viewer imports a bank file too: its rows land uncategorised (rawInsertOnly).
    'POST /api/import/bank-file/execute': READER_HOUSE,
    'POST /api/import/skattekonto-file/parse': READ,
    'POST /api/import/opening-balance/parse': READ,
    'POST /api/import/sie/parse': READ,
    // The append preview (issue #108): reads the file and the books, writes nothing.
    'POST /api/import/sie/append-plan': READ,
    'POST /api/import/sie/upload': BOOK_HOUSE,
    'POST /api/import/documents/preview': READ,
    'POST /api/import/documents/attach': BOOK_HOUSE,
    'POST /api/import/customers/parse': READ,
    'POST /api/import/suppliers/parse': READ,
    'POST /api/import/articles/parse': READ,
    'POST /api/import/articles/match': READ,
    'POST /api/import/customers/execute': INVOICING_RECORD,
    'POST /api/import/articles/execute': INVOICING_RECORD,
    'POST /api/import/suppliers/execute': BOOK_RECORD,
    '/api/import/registers': BOOK_RECORD,
    '/api/bank': BOOK_HOUSE,
    'PATCH /api/bank/connections/:id/ledgers': BOOK_RECORD,
    // Inviting the firmatecknare to connect a bank: requireAdmin today.
    'POST /api/bank/open-payments/invites': SETTINGS,
    '/api/digital-mailboxes': SETTINGS,
    'POST /api/digital-mailboxes/:provider/sync': BOOK_HOUSE,
    '/api/assets': BOOK_RECORD,
    'POST /api/assets/:id/dispose': BOOK,
    // Agreements, ställda säkerheter, eventualförpliktelser and group links:
    // registers, nothing posts to the ledger (requireWrite today).
    '/api/commitments': BOOK_RECORD,
    '/api/expense-claims': BOOK,
    'POST /api/expense-claims/suggest-template': READ,
    '/api/pos-sales': BOOK_RECORD,
    'POST /api/pos-sales/fetch': BOOK_HOUSE,
    'POST /api/pos-sales/days/:id/book': BOOK,
    '/api/webshop-orders': BOOK,
    'POST /api/webshop-orders/:id/create-invoice': INVOICING,
    'PUT /api/webshop-orders/settings': BOOK_RECORD,

    // ── Bolaget: the company's statutory registers ─────────────────────
    // Ownership and signatories: the aktiebok, the share classes, the roles,
    // the firmateckning, the verkliga huvudmän, the register's people
    // (identity and address of holders and role persons) and the register
    // settings (avstämningsbolag). Owner/admin (requireAdmin).
    '/api/bolaget/share-register': SETTINGS,
    '/api/bolaget/share-classes': SETTINGS,
    '/api/bolaget/roles': SETTINGS,
    '/api/bolaget/signatory-rules': SETTINGS,
    '/api/bolaget/beneficial-owners': SETTINGS,
    '/api/bolaget/people': SETTINGS,
    '/api/bolaget/settings': SETTINGS,
    // Meetings and minutes: an adopted election changes the roles when the
    // minutes are signed; nothing posts to the ledger. Any writer.
    '/api/bolaget/meetings': BOOK_RECORD,
    // Capital events: recording a decision, cancelling it, the KU31 answer
    // and linking a payout already booked write the register; booking a
    // decision, paying a dividend and a shareholder contribution post
    // through the engine.
    '/api/bolaget/capital': BOOK_RECORD,
    'POST /api/bolaget/capital/dividends/:id/book': BOOK,
    'POST /api/bolaget/capital/dividends/:id/pay': BOOK,
    'POST /api/bolaget/capital/contributions': BOOK,
    'POST /api/bolaget/capital/changes/:id/book': BOOK,
    // Owner tax: the K10 inputs and the owner loan register; nothing posts.
    '/api/bolaget/owner-tax': BOOK_RECORD,

    // ── Invoicing ──────────────────────────────────────────────────────
    '/api/invoices': INVOICING,
    'POST /api/invoices/preview-pdf': INVOICING_READ,
    'POST /api/invoices/preview-email': INVOICING_READ,
    'POST /api/invoices/:id/quote-status': INVOICING_RECORD,
    'PUT /api/invoices/autogiro/settings': INVOICING_RECORD,
    '/api/customers': INVOICING_RECORD,
    '/api/articles': INVOICING_RECORD,
    '/api/sales-orders': INVOICING_RECORD,
    'POST /api/sales-orders/:id/create-invoice': INVOICING,
    '/api/reminders': INVOICING,
    // Automatic reminders: requireAdmin today.
    'POST /api/reminders/automatic': SETTINGS_LEDGER,
    '/api/collections': BOOK,
    '/api/rot-rut': INVOICING,
    'POST /api/rot-rut/payout-requests/:id/settle': BOOK,
    'POST /api/vat/validate': INVOICING_READ,

    // ── Suppliers and payments ─────────────────────────────────────────
    '/api/suppliers': BOOK_RECORD,
    '/api/supplier-invoices': BOOK,
    '/api/supplier-invoices/payment-batches': PAYMENTS,
    'POST /api/supplier-invoices/payment-batches/preview': PAYMENTS_READ,
    'POST /api/supplier-invoices/:id/payee': PAYMENTS_RECORD,
    'POST /api/supplier-invoices/:id/bank-entered': PAYMENTS,
    'PUT /api/supplier-invoices/attest-policy': SETTINGS,
    '/api/payments': PAYMENTS,

    // ── Payroll ────────────────────────────────────────────────────────
    '/api/salary': PAYROLL,
    '/api/salary/employees': PAYROLL_RECORD,
    '/api/salary/premium-rules': PAYROLL_RECORD,
    '/api/salary/runs/:id/payment': PAYMENTS,
    // The vacation liability method: requireAdmin today.
    'POST /api/salary/vacation-liability/method': SETTINGS,
    '/api/mileage': PAYROLL_RECORD,
    'POST /api/mileage/book': BOOK,
    'POST /api/mileage/salary-push': PAYROLL,

    // ── Moms, declarations and Skatteverket ────────────────────────────
    '/api/reports': TAX,
    // A person's liquidity forecast rows: planning data no verifikat reads,
    // the same door as forecast:write on v1 and MCP.
    '/api/reports/cash-forecast/rows': BOOK_HOUSE,
    '/api/tax-assessment-notices': TAX,
    '/api/skatteverket': TAX,

    // ── Extension routes, through the dispatcher ───────────────────────
    '/api/extensions/ext/arcim-migration': BOOK,
    '/api/extensions/ext/cloud-backup': BOOK_HOUSE,
    // The company's own sending domain: owner or admin (the handler checks).
    '/api/extensions/ext/email': SETTINGS,
    '/api/extensions/ext/enable-banking': BOOK_HOUSE,
    // A viewer syncs too: its rows land uncategorised (rawInsertOnly).
    'POST /api/extensions/ext/enable-banking/sync': READER_HOUSE,
    '/api/extensions/ext/invoice-inbox': BOOK_HOUSE,
    'POST /api/extensions/ext/invoice-inbox/items/:id/convert': BOOK,
    'POST /api/extensions/ext/invoice-inbox/items/:id/book-direct': BOOK,
    'POST /api/extensions/ext/invoice-inbox/items/bulk-book': BOOK,
    'POST /api/extensions/ext/invoice-inbox/items/:id/suggest-booking': READ,
    // The company's inbox address: owner or admin (the handler checks).
    '/api/extensions/ext/invoice-inbox/inbox': SETTINGS,
    '/api/extensions/ext/mail': BOOK_HOUSE,
    // Disconnecting only reduces access: the person who connected the
    // mailbox may always do it, a colleague's needs an owner or admin.
    'DELETE /api/extensions/ext/mail/connections': READER_HOUSE,
    '/api/extensions/ext/shopify': BOOK_HOUSE,
    '/api/extensions/ext/stripe': BOOK_HOUSE,
    '/api/extensions/ext/woocommerce': BOOK_HOUSE,
    '/api/extensions/ext/zettle': BOOK_HOUSE,
    '/api/extensions/ext/skatteverket': TAX,
    // Validates against Skatteverket and files nothing (exempt from requireSkvWriteRole).
    'POST /api/extensions/ext/skatteverket/declaration/validate': READ,
    // Deletes only the caller's own Skatteverket token.
    'POST /api/extensions/ext/skatteverket/disconnect': OUTSIDE.personal,
    '/api/extensions/ext/skatteverket/skattekonto': BOOK,
    'POST /api/extensions/ext/skatteverket/skattekonto/sync': BOOK_HOUSE,
    'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/group-match-candidates': READ,
    'POST /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/match': BOOK_RECORD,
    'PATCH /api/extensions/ext/skatteverket/skattekonto/transaktioner/:id/ignore': BOOK_RECORD,
    'POST /api/extensions/ext/tic/lookup': OUTSIDE.newCompany,
    '/api/extensions/ext/tic/bankid': OUTSIDE.personal,
    '/api/extensions/ext/whatsapp-inbox': OUTSIDE.personal,
  })

interface ParsedRule {
  key: string
  method: string | null
  segments: string[]
  rule: DoorSpec | StagingSpec | OutsideDoor
}

const PARSED_RULES: readonly ParsedRule[] = Object.entries(SESSION_DOOR_RULES).map(([key, rule]) => {
  const space = key.indexOf(' ')
  const method = space === -1 ? null : key.slice(0, space)
  const path = space === -1 ? key : key.slice(space + 1)
  return { key, method, segments: path.split('/').filter(Boolean), rule }
})

const isParam = (segment: string) => segment.startsWith(':')

/**
 * How well a rule matches a route: null when it does not, else a score
 * (more segments, then more literal segments, then a named method). In
 * `key` mode the path is a route key's pattern and a rule's `:param` matches
 * only a `:param`; in `request` mode the path is concrete and a `:param`
 * matches any segment.
 */
function score(rule: ParsedRule, method: string, path: readonly string[], mode: 'key' | 'request'): number | null {
  if (rule.method !== null && rule.method !== method) return null
  if (rule.segments.length > path.length) return null
  let literals = 0
  for (let i = 0; i < rule.segments.length; i++) {
    const want = rule.segments[i]
    const have = path[i]
    if (isParam(want)) {
      if (mode === 'key' && !isParam(have)) return null
    } else {
      if (want !== have) return null
      literals++
    }
  }
  return rule.segments.length * 10_000 + literals * 10 + (rule.method ? 1 : 0)
}

function bestRule(method: string, path: readonly string[], mode: 'key' | 'request'): ParsedRule | null {
  let best: ParsedRule | null = null
  let bestScore = -1
  for (const rule of PARSED_RULES) {
    const s = score(rule, method, path, mode)
    if (s !== null && s > bestScore) {
      best = rule
      bestScore = s
    }
  }
  return best
}

function toDoor(rule: ParsedRule['rule']): DoorRule {
  if (isOutsideDoor(rule)) return rule
  return { ...rule, stageable: 'stageable' in rule && rule.stageable === true }
}

/** The rule key that classifies a session route key ('POST /api/invoices/:id/send'), or null. */
export function sessionRuleForKey(routeKey: string): string | null {
  const [method, path] = routeKey.split(' ')
  return bestRule(method, path.split('/').filter(Boolean), 'key')?.key ?? null
}

/** The door of a session route key ('POST /api/invoices/:id/send'). Null: unclassified. */
export function sessionRouteDoor(routeKey: string): DoorRule | null {
  const [method, path] = routeKey.split(' ')
  const rule = bestRule(method, path.split('/').filter(Boolean), 'key')
  return rule ? toDoor(rule.rule) : null
}

/** The door of a concrete session request ('POST', '/api/invoices/<uuid>/send'). Null: unclassified. */
export function sessionRequestDoor(method: string, pathname: string): DoorRule | null {
  const rule = bestRule(method.toUpperCase(), pathname.split('/').filter(Boolean), 'request')
  return rule ? toDoor(rule.rule) : null
}
