/**
 * Typed handles: the public id format that says which kind of record an id
 * names.
 *
 *   je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b  =  journal entry 0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b
 *
 * A handle is `<prefix>_<the row's UUID as 32 lowercase hex, no dashes>`. It
 * is the UUID, spelled with its type in front: nothing is stored, any UUID
 * has exactly one handle per type, and the UUID comes back by stripping the
 * prefix and putting the dashes back (./format.ts). Agents store the ids the
 * API returns; a bare UUID cannot tell a journal entry from an invoice, so a
 * wrong-type id fails late, far from where it was mixed up. A handle fails at
 * the door instead (HANDLE_TYPE_MISMATCH).
 *
 * THIS TABLE IS A PUBLIC CONTRACT. Agents and integrations store handles for
 * years (BFL keeps the records seven), so a prefix is never renamed, never
 * reused for another type and never removed. Add a type with a new prefix;
 * leave every existing row as it is (pinned by __tests__/handles.test.ts).
 *
 * Plain UUIDs stay valid everywhere a handle is: the format is additive.
 * Resources without a row here (sub-resources such as salary lines and
 * employee benefits) are addressed by plain UUID only; giving one a prefix
 * later is additive too.
 *
 * Kept free of imports beyond the UUID shape: the v1 wrapper and the MCP
 * dispatcher load it on every request.
 */

/** One resource type a handle can name. */
export interface HandleResource {
  /** Stable type key, snake_case singular. Published in error details. */
  readonly type: string
  /** The prefix before the underscore: lowercase letters, unique, permanent. */
  readonly prefix: string
  /** English name, for error messages and docs. */
  readonly label: string
  /**
   * The v1 path segments whose next segment is this type's id
   * (`/journal-entries/:id`). A path parameter after any other segment is
   * not a typed id and takes a plain UUID only.
   */
  readonly segments: readonly string[]
  /**
   * Field-name bases that hold this type's id in request bodies, query
   * strings and MCP arguments: `<base>_id`, `<base>_ids`, and any role
   * before it (`credited_invoice_id`, `expected_journal_entry_ids`). See
   * ./fields.ts for the exact rule and its exclusions.
   */
  readonly fields: readonly string[]
}

export const HANDLE_RESOURCES = [
  { type: 'company', prefix: 'cmp', label: 'company', segments: ['companies'], fields: ['company'] },
  { type: 'journal_entry', prefix: 'je', label: 'journal entry', segments: ['journal-entries'], fields: ['journal_entry'] },
  { type: 'invoice', prefix: 'inv', label: 'customer invoice', segments: ['invoices'], fields: ['invoice'] },
  { type: 'supplier_invoice', prefix: 'sinv', label: 'supplier invoice', segments: ['supplier-invoices'], fields: ['supplier_invoice'] },
  { type: 'customer', prefix: 'cus', label: 'customer', segments: ['customers'], fields: ['customer'] },
  { type: 'supplier', prefix: 'sup', label: 'supplier', segments: ['suppliers'], fields: ['supplier'] },
  { type: 'transaction', prefix: 'txn', label: 'bank transaction', segments: ['transactions'], fields: ['transaction'] },
  { type: 'document', prefix: 'doc', label: 'document', segments: ['documents', 'underlag'], fields: ['document'] },
  { type: 'pending_operation', prefix: 'pop', label: 'pending operation', segments: ['pending-operations'], fields: ['pending_operation'] },
  { type: 'fiscal_period', prefix: 'fp', label: 'fiscal period', segments: ['fiscal-periods'], fields: ['fiscal_period', 'period'] },
  { type: 'employee', prefix: 'emp', label: 'employee', segments: ['employees', 'payslips'], fields: ['employee'] },
  { type: 'salary_run', prefix: 'srun', label: 'salary run', segments: ['salary-runs'], fields: ['salary_run'] },
  { type: 'article', prefix: 'art', label: 'article', segments: ['articles'], fields: ['article'] },
  { type: 'asset', prefix: 'ast', label: 'fixed asset', segments: ['assets'], fields: ['asset'] },
  { type: 'dimension', prefix: 'dim', label: 'dimension', segments: ['dimensions'], fields: ['dimension'] },
  { type: 'dimension_value', prefix: 'dimv', label: 'dimension value', segments: ['values'], fields: ['dimension_value'] },
  { type: 'inbox_item', prefix: 'inbx', label: 'inbox item', segments: ['inbox-items'], fields: ['inbox_item'] },
  { type: 'expense_claim', prefix: 'exp', label: 'expense claim', segments: ['expense-claims'], fields: ['expense_claim'] },
  { type: 'cash_account', prefix: 'cash', label: 'cash account', segments: ['cash-accounts'], fields: ['cash_account'] },
  { type: 'payment_order', prefix: 'pmt', label: 'payment order', segments: ['payment-orders'], fields: ['payment_order'] },
  { type: 'supplier_payment_batch', prefix: 'spb', label: 'supplier payment batch', segments: ['supplier-payment-batches'], fields: ['supplier_payment_batch'] },
  { type: 'webhook', prefix: 'wh', label: 'webhook', segments: ['webhooks'], fields: ['webhook'] },
  { type: 'webhook_delivery', prefix: 'whd', label: 'webhook delivery', segments: ['webhook-deliveries'], fields: ['webhook_delivery'] },
  { type: 'operation', prefix: 'op', label: 'async operation', segments: ['operations'], fields: [] },
  { type: 'service_account', prefix: 'svc', label: 'service account', segments: ['service-accounts'], fields: ['service_account'] },
  { type: 'api_key', prefix: 'key', label: 'API key', segments: ['keys'], fields: ['api_key'] },
  // A row of the trigger-written audit log (GET /audit-trail).
  { type: 'audit_log_entry', prefix: 'aud', label: 'audit log entry', segments: [], fields: ['audit_log_entry'] },
  // An "avstämt t.o.m." sign-off on a reconcilable account. A bare
  // `signoff_id` stays untyped: the name alone does not say which sign-off.
  { type: 'reconciliation_signoff', prefix: 'rso', label: 'reconciliation sign-off', segments: ['signoff'], fields: ['reconciliation_signoff'] },
  { type: 'voucher_gap_explanation', prefix: 'vgap', label: 'voucher gap explanation', segments: [], fields: ['voucher_gap_explanation'] },
  { type: 'team', prefix: 'team', label: 'team', segments: [], fields: ['team'] },
  // What a posting meant in business terms (posting port, business_events).
  // No v1 route reads one yet; the field base types business_event_id.
  { type: 'business_event', prefix: 'bev', label: 'business event', segments: [], fields: ['business_event'] },
  // An SIE import job (a sie_imports row: a file upload or a provider
  // migration), the subject of its ledger.history_import business event.
  // Types no v1 path or field yet: the import routes keep their plain UUIDs.
  { type: 'sie_import', prefix: 'sie', label: 'SIE import', segments: [], fields: [] },
] as const satisfies readonly HandleResource[]

export type HandleType = (typeof HANDLE_RESOURCES)[number]['type']
export type HandlePrefix = (typeof HANDLE_RESOURCES)[number]['prefix']

const BY_TYPE = new Map<string, HandleResource>(HANDLE_RESOURCES.map((r) => [r.type, r]))
const BY_PREFIX = new Map<string, HandleResource>(HANDLE_RESOURCES.map((r) => [r.prefix, r]))
const BY_SEGMENT = new Map<string, HandleResource>(
  HANDLE_RESOURCES.flatMap((r) => r.segments.map((s) => [s, r] as const)),
)

export function handleResource(type: HandleType): HandleResource {
  // Every HandleType is a row of the table by construction.
  return BY_TYPE.get(type)!
}

/** The resource a prefix names, or undefined for an unknown prefix. */
export function resourceForPrefix(prefix: string): HandleResource | undefined {
  return BY_PREFIX.get(prefix)
}

/**
 * The type of a v1 path parameter, from the segment before it
 * (`journal-entries` for `/journal-entries/:id`), or undefined when the
 * parameter is not a typed id (it takes a plain UUID or another key).
 */
export function typeForPathSegment(segment: string | undefined): HandleType | undefined {
  if (segment === undefined) return undefined
  return BY_SEGMENT.get(segment)?.type as HandleType | undefined
}

export function isHandleType(value: unknown): value is HandleType {
  return typeof value === 'string' && BY_TYPE.has(value)
}
