/**
 * The ROT/RUT begäran state of one invoice, as the invoice list reads it.
 *
 * One predicate for the ROT/RUT column, the filter and its counts, so the
 * three can never drift (the same shape as invoice-list-tabs.ts). The list
 * embeds `rot_rut_payout_request_items` with their parent request; this file
 * only decides which request speaks for the invoice.
 *
 * Which request: the trigger enforce_single_active_rot_rut_request keeps an
 * invoice in at most ONE active begäran (status not cancelled/rejected), so
 * the active one is the state. Without an active request the newest
 * historical row (an avslag or a cancelled file) still explains the invoice
 * until it is re-requested. Without any request, a paid invoice that carries
 * a deduction is waiting for its begäran ("Att begära", the same rule as
 * skvClaimable on the invoice page); anything else has nothing to say.
 */

export const ROT_RUT_REQUEST_STATUSES = [
  'generated',
  'submitted',
  'paid',
  'partially_paid',
  'rejected',
  'cancelled',
] as const
export type RotRutRequestStatus = (typeof ROT_RUT_REQUEST_STATUSES)[number]

/** Request statuses that no longer hold the invoice: history, not state. */
const INACTIVE_REQUEST_STATUSES: readonly string[] = ['cancelled', 'rejected']

export type RotRutListState = RotRutRequestStatus | 'claimable' | null

export interface RotRutListRequest {
  id: string
  status: string
  created_at: string
}

/** The shape PostgREST returns for the reverse embed on the list query. */
export interface RotRutListItem {
  request: RotRutListRequest | RotRutListRequest[] | null
}

export type RotRutListInvoice = {
  status: string
  deduction_total?: number | null
  rot_rut_items?: RotRutListItem[] | null
}

function isRequestStatus(status: string): status is RotRutRequestStatus {
  return (ROT_RUT_REQUEST_STATUSES as readonly string[]).includes(status)
}

function requestsOf(invoice: RotRutListInvoice): RotRutListRequest[] {
  const requests: RotRutListRequest[] = []
  for (const item of invoice.rot_rut_items ?? []) {
    const embedded = item.request
    if (!embedded) continue
    if (Array.isArray(embedded)) requests.push(...embedded)
    else requests.push(embedded)
  }
  return requests
}

export function rotRutListStateOf(invoice: RotRutListInvoice): RotRutListState {
  const requests = requestsOf(invoice).filter((request) => isRequestStatus(request.status))
  const active = requests.find((request) => !INACTIVE_REQUEST_STATUSES.includes(request.status))
  if (active) return active.status as RotRutRequestStatus
  if (requests.length > 0) {
    const newest = [...requests].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    return newest.status as RotRutRequestStatus
  }
  if ((invoice.deduction_total ?? 0) > 0 && invoice.status === 'paid') return 'claimable'
  return null
}

/**
 * The filter's values: the states a user looks for. `cancelled` is not a
 * view of its own (a cancelled file is a non-event for the invoice), it only
 * shows in the column until the invoice is requested again.
 */
export const ROT_RUT_LIST_FILTERS = [
  'all',
  'claimable',
  'generated',
  'submitted',
  'paid',
  'partially_paid',
  'rejected',
] as const
export type RotRutListFilter = (typeof ROT_RUT_LIST_FILTERS)[number]

export function parseRotRutListFilter(param: string | null): RotRutListFilter | null {
  if (!param) return null
  return (ROT_RUT_LIST_FILTERS as readonly string[]).includes(param)
    ? (param as RotRutListFilter)
    : null
}

export function matchesRotRutListFilter(
  invoice: RotRutListInvoice,
  filter: RotRutListFilter,
): boolean {
  if (filter === 'all') return true
  return rotRutListStateOf(invoice) === filter
}
