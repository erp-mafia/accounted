import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import {
  buildRotRutFile,
  evaluateInvoiceForFile,
  type BuildRotRutFileResult,
  type RotRutBlocker,
  type RotRutBlockerCode,
} from './rot-rut-file'
import type { DeductionType } from './rot-rut-rules'

/**
 * Shared service behind the rot/rut payout-file API routes and the MCP tool
 * (gnubok_generate_rot_rut_file): one implementation of "which invoices can
 * go into a begäran" and "record the begäran", so the two surfaces can never
 * drift apart.
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

export interface RotRutBlockedSummary {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  code: RotRutBlockerCode | 'ALREADY_REQUESTED'
  message: string
}

type InvoiceWithCustomer = Invoice & { customer?: { name?: string | null } | null }

/** Invoice statuses a candidate may carry. partially_paid is included because
 *  invoices settled through older payment paths can hold a fully paid
 *  customer share while the status never flipped to paid:
 *  evaluateInvoiceForFile decides via the derived customer share
 *  (total - paid_amount - deduction_total). */
const CANDIDATE_STATUSES = ['paid', 'partially_paid']

/**
 * Deduction-carrying invoices evaluated against the file rules. Never drops
 * an invoice silently: every fetched candidate lands in `eligible` or in
 * `blocked` with the exact reason, including "the deduction is the other
 * type" (NO_DEDUCTION_OF_TYPE, so the ROT view can point at the RUT list and
 * vice versa) and "already part of an in-flight begäran" (ALREADY_REQUESTED,
 * for generated/submitted requests). The single deliberate omission is an
 * invoice whose begäran has been decided (request status paid or
 * partially_paid): that claim is finished business, visible in the request
 * history, not a drop-out anyone needs explained.
 */
export async function listRotRutCandidates(
  supabase: SupabaseClient,
  companyId: string,
  type: DeductionType,
  // Europe/Stockholm, not UTC: this date gates FUTURE_PAYMENT_DATE and the
  // 31 January begäran deadline, both defined by Swedish calendar days.
  today = getSwedishLocalDate(),
): Promise<
  | { ok: true; eligible: RotRutCandidateSummary[]; blocked: RotRutBlockedSummary[] }
  | { ok: false; dbError: unknown }
> {
  // Two fetches so no candidate shape is invisible:
  //  - by header: deduction_total > 0, the classic shape;
  //  - by lines: invoices whose items carry deduction_type but whose header
  //    total was never written (older imports). The header filter would miss
  //    those entirely, which is exactly the silent drop this list must not
  //    have; they surface as DEDUCTION_TOTAL_MISSING.
  const { data: byHeader, error: headerError } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*), customer:customers(id, name)')
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .in('status', CANDIDATE_STATUSES)
    .gt('deduction_total', 0)
    .order('paid_at', { ascending: true })

  if (headerError) return { ok: false, dbError: headerError }

  const { data: byLines, error: linesError } = await supabase
    .from('invoices')
    .select(
      '*, items:invoice_items(*), customer:customers(id, name), deduction_lines:invoice_items!inner(deduction_type)',
    )
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .in('status', CANDIDATE_STATUSES)
    .not('deduction_lines.deduction_type', 'is', null)
    .order('paid_at', { ascending: true })

  if (linesError) return { ok: false, dbError: linesError }

  const invoiceById = new Map<string, InvoiceWithCustomer>()
  for (const row of [
    ...(byHeader ?? []),
    ...(byLines ?? []),
  ] as unknown as InvoiceWithCustomer[]) {
    if (!invoiceById.has(row.id)) invoiceById.set(row.id, row)
  }
  // Deterministic order across the merged sets: oldest payment first
  // (matching the old single-query order), date-less rows last.
  const invoices = [...invoiceById.values()].sort((a, b) => {
    const aKey = a.paid_at ? String(a.paid_at) : '9999'
    const bKey = b.paid_at ? String(b.paid_at) : '9999'
    return aKey === bKey ? a.id.localeCompare(b.id) : aKey < bKey ? -1 : 1
  })

  const { data: activeItems, error: activeError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, request:rot_rut_payout_requests!inner(id, name, status, company_id)')
    .eq('request.company_id', companyId)
    .not('request.status', 'in', '("cancelled","rejected")')

  if (activeError) return { ok: false, dbError: activeError }

  const activeRequestByInvoice = new Map<string, { name: string | null; status: string }>()
  for (const row of (activeItems ?? []) as unknown as Array<{
    invoice_id: string
    request: { name?: string | null; status?: string } | null
  }>) {
    activeRequestByInvoice.set(row.invoice_id, {
      name: row.request?.name ?? null,
      status: row.request?.status ?? '',
    })
  }

  const eligible: RotRutCandidateSummary[] = []
  const blocked: RotRutBlockedSummary[] = []

  for (const invoice of invoices) {
    const activeRequest = activeRequestByInvoice.get(invoice.id)
    const inFlightRequest =
      activeRequest &&
      (activeRequest.status === 'generated' || activeRequest.status === 'submitted')
        ? activeRequest
        : null
    // Decided begäran (request status paid/partially_paid) first, before ANY
    // classification: the claim is finished business on every tab, so the
    // invoice must vanish from both lists. Checking wrong-type first would
    // resurface every historically decided invoice forever in the OTHER
    // type's blocked list.
    if (activeRequest && !inFlightRequest) continue

    const result = evaluateInvoiceForFile(type, invoice, { today })

    // Wrong-type next: even when the invoice sits in an in-flight begäran,
    // the useful fact under THIS type is that it belongs to the other list
    // (where it shows as ALREADY_REQUESTED).
    if (!result.ok && result.blocker.code === 'NO_DEDUCTION_OF_TYPE') {
      blocked.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        customer_name: invoice.customer?.name ?? null,
        code: result.blocker.code,
        message: result.blocker.message,
      })
      continue
    }

    if (inFlightRequest) {
      // In-flight begäran (generated but maybe never uploaded, or awaiting
      // beslut): the invoice is spoken for, say so instead of vanishing.
      const requestLabel = inFlightRequest.name ? `begäran "${inFlightRequest.name}"` : 'en begäran'
      blocked.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        customer_name: invoice.customer?.name ?? null,
        code: 'ALREADY_REQUESTED',
        message:
          inFlightRequest.status === 'generated'
            ? `Fakturan ingår redan i ${requestLabel} som är skapad men inte uppladdad. Ladda upp filen hos Skatteverket, eller avbryt begäran för att ta med fakturan i en ny fil.`
            : `Fakturan ingår redan i ${requestLabel} som väntar på Skatteverkets beslut.`,
      })
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
      blocked.push({
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number ?? null,
        customer_name: invoice.customer?.name ?? null,
        code: result.blocker.code,
        message: result.blocker.message,
      })
    }
  }

  return { ok: true, eligible, blocked }
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
    type: DeductionType
    invoiceIds: string[]
    name?: string
    today?: string
  },
): Promise<CreateRotRutRequestResult> {
  const today = params.today ?? getSwedishLocalDate()
  const name = (params.name ?? `${params.type.toUpperCase()} ${today}`).slice(0, 16)

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
