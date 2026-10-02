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
 *
 * Grön teknik is the exception to "Att begära": its payout is requested in
 * Skatteverkets e-tjänst for grön teknik, which writes no begäran row here,
 * so a paid grön teknik invoice would read "Att begära" forever, even after
 * the request was made and paid. It reads `etjanst` ("Begärs i e-tjänsten")
 * instead: a neutral state, outside the "Att begära" filter and its count.
 * Once a begäran row exists for it (the Begaran GRON_TEKNIK file), that row
 * speaks for it like any other.
 */
import { deductionKindsOf } from './rot-rut-rules'

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

export type RotRutListState = RotRutRequestStatus | 'claimable' | 'etjanst' | null

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
  /** The invoice's deduction lines (their kind only): which e-tjänst claims it. */
  deduction_lines?: ReadonlyArray<{ deduction_type?: string | null }> | null
}

/** Every deduction line is grön teknik (it never shares an invoice with ROT/RUT). */
function isGronTeknikOnly(invoice: RotRutListInvoice): boolean {
  const kinds = deductionKindsOf(invoice.deduction_lines ?? [])
  return kinds.length > 0 && kinds.every((kind) => kind === 'gron_teknik')
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
  if ((invoice.deduction_total ?? 0) > 0 && invoice.status === 'paid') {
    return isGronTeknikOnly(invoice) ? 'etjanst' : 'claimable'
  }
  return null
}

/**
 * The filter's values: the states a user looks for. `cancelled` is not a
 * view of its own (a cancelled file is a non-event for the invoice), it only
 * shows in the column until the invoice is requested again. Nor is
 * `etjanst`: it names where a grön teknik payout is requested, not a step
 * anyone can act on or track here.
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

/**
 * The list the payout dialog opens on from the invoice list: grön teknik when
 * every invoice carrying a deduction is grön teknik (an installer who never
 * sells ROT or RUT work), otherwise ROT, as it always has.
 */
export function payoutDialogTypeFor(
  invoices: ReadonlyArray<Pick<RotRutListInvoice, 'deduction_lines'>>,
): 'rot' | 'gron_teknik' {
  let sawGronTeknik = false
  for (const invoice of invoices) {
    const kinds = deductionKindsOf(invoice.deduction_lines ?? [])
    if (kinds.some((kind) => kind !== 'gron_teknik')) return 'rot'
    if (kinds.length > 0) sawGronTeknik = true
  }
  return sawGronTeknik ? 'gron_teknik' : 'rot'
}

export function matchesRotRutListFilter(
  invoice: RotRutListInvoice,
  filter: RotRutListFilter,
): boolean {
  if (filter === 'all') return true
  return rotRutListStateOf(invoice) === filter
}
