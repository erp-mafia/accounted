import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeductionType, Invoice } from '@/types'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  buildRotRutFile,
  evaluateInvoiceForFile,
  isPastRequestDeadline,
  type BuildRotRutFileResult,
  type ClaimProperty,
  type RotRutBlocker,
  type RotRutBlockerCode,
} from './rot-rut-file'
import { evaluateGronTeknikClaim, type GronTeknikInstallation } from './gron-teknik-claim'
import { DEDUCTION_TYPE_LABELS, deductionKindsOf, type HusDeductionType } from './rot-rut-rules'

/**
 * Shared service behind the rot/rut payout-file API routes and the MCP tool
 * (gnubok_generate_rot_rut_file): one implementation of "which invoices can
 * go into a begäran" and "record the begäran", so the two surfaces can never
 * drift apart. Grön teknik invoices are listed from the same fetch
 * (listGronTeknikCandidates) but never enter a HUS file.
 */

export interface RotRutCandidateSummary {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  personnummer_last4: string
  betalnings_datum: string
  pris_for_arbete: number
  begart_belopp: number
}

/**
 * A paid grön teknik invoice with the figures its ärenden need (one per
 * installation type), for the request made in Skatteverkets e-tjänst. The
 * buyer's full personnummer is not here: it is read on the invoice page.
 */
export interface GronTeknikCandidateSummary {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  personnummer_last4: string
  betalnings_datum: string
  /** Fastighetsbeteckning, or lägenhetsnummer + the förening's orgnr. */
  property: ClaimProperty
  installations: GronTeknikInstallation[]
  ovrig_kostnad: number
  begart_belopp: number
  /** 31 January after the payment year has passed: too late to request. */
  past_deadline: boolean
  warnings: string[]
}

export interface RotRutBlockedSummary {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  code: RotRutBlockerCode | 'ALREADY_REQUESTED'
  message: string
}

/**
 * Invoices counted instead of listed: their deduction is a kind requested in
 * another e-tjänst (grön teknik on a ROT/RUT list, ROT/RUT on the grön teknik
 * list). An installer with a hundred grön teknik invoices a month would
 * otherwise see a hundred identical pointer rows under ROT. They are never
 * dropped: each one is listed on its own kind's list (#1884).
 */
export type OtherTypeCounts = Partial<Record<DeductionType, number>>

type InvoiceWithCustomer = Invoice & { customer?: { name?: string | null } | null }

/** Invoice statuses a candidate may carry. partially_paid is included because
 *  invoices settled through older payment paths can hold a fully paid
 *  customer share while the status never flipped to paid:
 *  evaluateInvoiceForFile decides via the derived customer share
 *  (total - paid_amount - deduction_total). */
const CANDIDATE_STATUSES = ['paid', 'partially_paid']

/** Request statuses where Skatteverkets beslut has been recorded: the claim is
 *  finished business, visible in the request history, so the invoice is
 *  deliberately omitted from both lists (see DECISIONS.md, #1884). Enumerated
 *  explicitly so a request status outside the known lifecycle can never make
 *  an invoice vanish silently: anything not decided here, and not
 *  cancelled/rejected (filtered out in the query), surfaces as
 *  ALREADY_REQUESTED. */
const DECIDED_REQUEST_STATUSES = ['paid', 'partially_paid']

interface ActiveRequest {
  name: string | null
  status: string
}

interface ActiveItemRow {
  id: string
  invoice_id: string
  request: { name?: string | null; status?: string } | null
}

/**
 * Every deduction-carrying invoice a list may show, plus the begäran that
 * holds each one. Two fetches so no candidate shape is invisible:
 *  - by header: deduction_total > 0, the classic shape;
 *  - by lines: invoices whose items carry deduction_type but whose header
 *    total was never written (older imports). The header filter would miss
 *    those entirely, which is exactly the silent drop this list must not
 *    have; they surface as DEDUCTION_TOTAL_MISSING.
 *
 * Every read pages through fetchAllRows: PostgREST caps one read at 1000
 * rows, and these sets only grow (decided invoices are still fetched and
 * dropped in memory, and a grön teknik invoice gets no begäran row until the
 * Begaran file exists). A capped read sorted oldest payment first silently
 * lost the NEWEST paid invoices, the ones still to request, and a capped
 * begäran read could make an invoice already requested look requestable.
 * Each read orders on a unique tail (id) so pages never skip or repeat a row.
 */
async function fetchDeductionCandidates(
  supabase: SupabaseClient,
  companyId: string,
): Promise<
  | { ok: true; invoices: InvoiceWithCustomer[]; activeRequestByInvoice: Map<string, ActiveRequest> }
  | { ok: false; dbError: unknown }
> {
  let byHeader: InvoiceWithCustomer[]
  let byLines: InvoiceWithCustomer[]
  let activeItems: ActiveItemRow[]
  try {
    byHeader = await fetchAllRows<InvoiceWithCustomer>(
      ({ from, to }) =>
        supabase
          .from('invoices')
          .select('*, items:invoice_items(*), customer:customers(id, name)')
          .eq('company_id', companyId)
          .eq('document_type', 'invoice')
          .in('status', CANDIDATE_STATUSES)
          .gt('deduction_total', 0)
          .order('paid_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id },
    )

    byLines = await fetchAllRows<InvoiceWithCustomer>(
      ({ from, to }) =>
        supabase
          .from('invoices')
          .select(
            '*, items:invoice_items(*), customer:customers(id, name), deduction_lines:invoice_items!inner(deduction_type)',
          )
          .eq('company_id', companyId)
          .eq('document_type', 'invoice')
          .in('status', CANDIDATE_STATUSES)
          .not('deduction_lines.deduction_type', 'is', null)
          .order('paid_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id },
    )

    // The select parser types the many-to-one embed as an array; PostgREST
    // returns the one parent row as an object, as ActiveItemRow says.
    const activeRows = await fetchAllRows(
      ({ from, to }) =>
        supabase
          .from('rot_rut_payout_request_items')
          .select('id, invoice_id, request:rot_rut_payout_requests!inner(id, name, status, company_id)')
          .eq('request.company_id', companyId)
          .not('request.status', 'in', '("cancelled","rejected")')
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id },
    )
    activeItems = activeRows as unknown as ActiveItemRow[]
  } catch (dbError) {
    return { ok: false, dbError }
  }

  const invoiceById = new Map<string, InvoiceWithCustomer>()
  for (const row of [...byHeader, ...byLines]) {
    if (!invoiceById.has(row.id)) invoiceById.set(row.id, row)
  }
  // Deterministic order across the merged sets: oldest payment first
  // (matching the old single-query order), date-less rows last.
  const invoices = [...invoiceById.values()].sort((a, b) => {
    const aKey = a.paid_at ? String(a.paid_at) : '9999'
    const bKey = b.paid_at ? String(b.paid_at) : '9999'
    return aKey === bKey ? a.id.localeCompare(b.id) : aKey < bKey ? -1 : 1
  })

  const activeRequestByInvoice = new Map<string, ActiveRequest>()
  for (const row of activeItems) {
    activeRequestByInvoice.set(row.invoice_id, {
      name: row.request?.name ?? null,
      status: row.request?.status ?? '',
    })
  }

  return { ok: true, invoices, activeRequestByInvoice }
}

/**
 * In-flight begäran (generated but maybe never uploaded, or awaiting
 * beslut): the invoice is spoken for, say so instead of vanishing. A request
 * status outside the known lifecycle gets the generic message: being held
 * with a vague reason still beats disappearing.
 */
function alreadyRequested(invoice: InvoiceWithCustomer, holdingRequest: ActiveRequest): RotRutBlockedSummary {
  const requestLabel = holdingRequest.name ? `begäran "${holdingRequest.name}"` : 'en begäran'
  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number ?? null,
    customer_name: invoice.customer?.name ?? null,
    code: 'ALREADY_REQUESTED',
    message:
      holdingRequest.status === 'generated'
        ? `Fakturan ingår redan i ${requestLabel} som är skapad men inte uppladdad. Ladda upp filen hos Skatteverket, eller avbryt begäran för att ta med fakturan i en ny fil.`
        : holdingRequest.status === 'submitted'
          ? `Fakturan ingår redan i ${requestLabel} som väntar på Skatteverkets beslut.`
          : `Fakturan ingår redan i ${requestLabel}.`,
  }
}

function blockedSummary(invoice: InvoiceWithCustomer, blocker: RotRutBlocker): RotRutBlockedSummary {
  return {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number ?? null,
    customer_name: invoice.customer?.name ?? null,
    code: blocker.code,
    message: blocker.message,
  }
}

function countOtherKinds(counts: OtherTypeCounts, kinds: DeductionType[]): void {
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
}

/**
 * Deduction-carrying invoices evaluated against the file rules. Never drops
 * an invoice silently: every fetched candidate lands in `eligible` or in
 * `blocked` with the exact reason, including "the deduction is the other
 * type" (NO_DEDUCTION_OF_TYPE, so the ROT view can point at the RUT list and
 * vice versa) and "already part of an in-flight begäran" (ALREADY_REQUESTED,
 * for generated/submitted requests), or is counted in `other_type_counts`
 * when its deduction is grön teknik (listed by listGronTeknikCandidates).
 * The single deliberate omission is an invoice whose begäran has been
 * decided (request status paid or partially_paid): that claim is finished
 * business, visible in the request history, not a drop-out anyone needs
 * explained.
 */
export async function listRotRutCandidates(
  supabase: SupabaseClient,
  companyId: string,
  type: HusDeductionType,
  // Europe/Stockholm, not UTC: this date gates FUTURE_PAYMENT_DATE and the
  // 31 January begäran deadline, both defined by Swedish calendar days.
  today = getSwedishLocalDate(),
): Promise<
  | {
      ok: true
      eligible: RotRutCandidateSummary[]
      blocked: RotRutBlockedSummary[]
      other_type_counts: OtherTypeCounts
    }
  | { ok: false; dbError: unknown }
> {
  const fetched = await fetchDeductionCandidates(supabase, companyId)
  if (!fetched.ok) return fetched

  const eligible: RotRutCandidateSummary[] = []
  const blocked: RotRutBlockedSummary[] = []
  const otherTypeCounts: OtherTypeCounts = {}

  for (const invoice of fetched.invoices) {
    const activeRequest = fetched.activeRequestByInvoice.get(invoice.id)
    // Decided begäran (request status paid/partially_paid, enumerated
    // explicitly in DECIDED_REQUEST_STATUSES) first, before ANY
    // classification: the claim is finished business on every tab, so the
    // invoice must vanish from both lists. Checking wrong-type first would
    // resurface every historically decided invoice forever in the OTHER
    // type's blocked list.
    if (activeRequest && DECIDED_REQUEST_STATUSES.includes(activeRequest.status)) continue
    const holdingRequest = activeRequest ?? null

    // A grön teknik invoice is counted, not listed: it is requested in its
    // own e-tjänst and appears on the grön teknik list.
    const kinds = deductionKindsOf(invoice.items ?? [])
    if (kinds.length > 0 && kinds.every((kind) => kind === 'gron_teknik')) {
      countOtherKinds(otherTypeCounts, kinds)
      continue
    }

    const result = evaluateInvoiceForFile(type, invoice, { today })

    // Wrong-type next: even when the invoice sits in an in-flight begäran,
    // the useful fact under THIS type is that it belongs to the other list
    // (where it shows as ALREADY_REQUESTED).
    if (!result.ok && result.blocker.code === 'NO_DEDUCTION_OF_TYPE') {
      blocked.push(blockedSummary(invoice, result.blocker))
      continue
    }

    if (holdingRequest) {
      blocked.push(alreadyRequested(invoice, holdingRequest))
      continue
    }

    if (result.ok) {
      eligible.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        customer_name: invoice.customer?.name ?? null,
        personnummer_last4: result.value.arende.personnummer_last4,
        betalnings_datum: result.value.arende.betalnings_datum,
        pris_for_arbete: result.value.arende.pris_for_arbete,
        begart_belopp: result.value.arende.begart_belopp,
      })
    } else {
      blocked.push(blockedSummary(invoice, result.blocker))
    }
  }

  return { ok: true, eligible, blocked, other_type_counts: otherTypeCounts }
}

/**
 * Grön teknik invoices evaluated with evaluateGronTeknikClaim: eligible ones
 * carry the figures each ärende needs, blocked ones the first reason.
 * ROT/RUT invoices are counted in `other_type_counts` (they are listed under
 * ROT and RUT). There is no grön teknik file yet: the request is made in
 * Skatteverkets e-tjänst for grön teknik, so no begäran row exists for these
 * invoices and nothing here writes one. `eligible` therefore means "paid and
 * complete", not "not yet requested": a request made in the e-tjänst is
 * invisible here, and callers must say so (the tile and the invoice list do).
 * The decided/in-flight begäran rules still apply, so the list is ready for
 * the Begaran GRON_TEKNIK file.
 *
 * Newest payment first: the invoice to enter next in the e-tjänst is the one
 * most recently paid, and the ones already entered sink down the list.
 */
export async function listGronTeknikCandidates(
  supabase: SupabaseClient,
  companyId: string,
  today = getSwedishLocalDate(),
): Promise<
  | {
      ok: true
      eligible: GronTeknikCandidateSummary[]
      blocked: RotRutBlockedSummary[]
      other_type_counts: OtherTypeCounts
    }
  | { ok: false; dbError: unknown }
> {
  const fetched = await fetchDeductionCandidates(supabase, companyId)
  if (!fetched.ok) return fetched

  const eligible: GronTeknikCandidateSummary[] = []
  const blocked: RotRutBlockedSummary[] = []
  const otherTypeCounts: OtherTypeCounts = {}

  for (const invoice of fetched.invoices) {
    const activeRequest = fetched.activeRequestByInvoice.get(invoice.id)
    if (activeRequest && DECIDED_REQUEST_STATUSES.includes(activeRequest.status)) continue

    const kinds = deductionKindsOf(invoice.items ?? [])
    if (!kinds.includes('gron_teknik')) {
      countOtherKinds(otherTypeCounts, kinds)
      continue
    }

    if (activeRequest) {
      blocked.push(alreadyRequested(invoice, activeRequest))
      continue
    }

    const result = evaluateGronTeknikClaim(invoice, { today })
    if (!result.ok) {
      blocked.push(blockedSummary(invoice, result.blocker))
      continue
    }
    eligible.push({
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number ?? null,
      customer_name: invoice.customer?.name ?? null,
      personnummer_last4: result.value.personnummer_last4,
      betalnings_datum: result.value.betalnings_datum,
      property: result.value.property,
      installations: result.value.installations,
      ovrig_kostnad: result.value.ovrig_kostnad,
      begart_belopp: result.value.begart_belopp,
      past_deadline: isPastRequestDeadline(result.value.betalnings_datum, today),
      warnings: result.value.warnings,
    })
  }

  // The fetch order is oldest payment first (stable, id-tied); reverse it
  // with the same tie-break so equal dates keep a deterministic order.
  eligible.sort((a, b) =>
    a.betalnings_datum === b.betalnings_datum
      ? b.invoice_id.localeCompare(a.invoice_id)
      : a.betalnings_datum < b.betalnings_datum
        ? 1
        : -1,
  )

  return { ok: true, eligible, blocked, other_type_counts: otherTypeCounts }
}

export type CreateRotRutRequestResult =
  | { ok: true; request: Record<string, unknown>; file: BuildRotRutFileResult }
  | {
      ok: false
      code:
        | 'ROT_RUT_REQUEST_NOT_FOUND'
        | 'ROT_RUT_NO_ELIGIBLE_INVOICES'
        | 'ROT_RUT_INVOICES_BLOCKED'
        | 'ROT_RUT_INVOICE_CONFLICT'
        | 'ROT_RUT_FILE_CREATE_FAILED'
      blockers?: RotRutBlocker[]
      missingInvoiceIds?: string[]
    }

/**
 * Generate the begäran file for the given invoices and record the request +
 * items. All-or-nothing: any blocked invoice rejects the whole call with the
 * per-invoice blockers. The DB trigger enforce_single_active_rot_rut_request
 * stays the authoritative double-request guard (surfaced as INVOICE_CONFLICT).
 *
 * Document archiving is deliberately NOT done here: it needs the storage
 * bucket and differs per surface (the API route archives, best-effort).
 */
export async function createRotRutPayoutRequest(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    type: HusDeductionType
    invoiceIds: string[]
    name?: string
    today?: string
  },
): Promise<CreateRotRutRequestResult> {
  const today = params.today ?? getSwedishLocalDate()
  const name = (params.name ?? `${DEDUCTION_TYPE_LABELS[params.type].short} ${today}`).slice(0, 16)

  const { data: invoices, error: invoicesError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .in('id', params.invoiceIds)

  if (invoicesError) {
    return { ok: false, code: 'ROT_RUT_FILE_CREATE_FAILED' }
  }
  const foundIds = new Set((invoices ?? []).map((i) => i.id))
  const missing = params.invoiceIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    return { ok: false, code: 'ROT_RUT_REQUEST_NOT_FOUND', missingInvoiceIds: missing }
  }

  const file = buildRotRutFile({
    type: params.type,
    name,
    invoices: (invoices ?? []) as unknown as Invoice[],
    today,
  })

  if (!file.xml) {
    return { ok: false, code: 'ROT_RUT_NO_ELIGIBLE_INVOICES', blockers: file.blockers }
  }
  if (file.blockers.length > 0) {
    return { ok: false, code: 'ROT_RUT_INVOICES_BLOCKED', blockers: file.blockers }
  }

  const { data: payoutRequest, error: insertError } = await supabase
    .from('rot_rut_payout_requests')
    .insert({
      company_id: companyId,
      user_id: userId,
      deduction_type: params.type,
      name,
      status: 'generated',
      requested_total: file.requested_total,
      file_name: file.file_name,
    })
    .select()
    .single()

  if (insertError || !payoutRequest) {
    return { ok: false, code: 'ROT_RUT_FILE_CREATE_FAILED' }
  }

  const itemRows = file.arenden.map((a) => ({
    request_id: payoutRequest.id,
    invoice_id: a.invoice_id,
    requested_amount: a.begart_belopp,
  }))
  const { error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .insert(itemRows)

  if (itemsError) {
    // Roll back the header row: without items the request is meaningless.
    await supabase.from('rot_rut_payout_requests').delete().eq('id', payoutRequest.id)
    const conflict =
      (itemsError as { code?: string }).code === '23505' ||
      itemsError.message?.includes('active rot/rut payout request')
    return { ok: false, code: conflict ? 'ROT_RUT_INVOICE_CONFLICT' : 'ROT_RUT_FILE_CREATE_FAILED' }
  }

  return { ok: true, request: payoutRequest, file }
}
