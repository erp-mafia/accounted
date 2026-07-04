import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'
import {
  buildRotRutFile,
  evaluateInvoiceForFile,
  type BuildRotRutFileResult,
  type RotRutBlocker,
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
  code: string
  message: string
}

type InvoiceWithCustomer = Invoice & { customer?: { name?: string | null } | null }

/**
 * Paid deduction-carrying invoices not yet claimed by an active begäran,
 * evaluated against the file rules. Invoices whose deduction belongs solely
 * to the other type are omitted entirely (they're the other list's business).
 */
export async function listRotRutCandidates(
  supabase: SupabaseClient,
  companyId: string,
  type: DeductionType,
): Promise<
  | { ok: true; eligible: RotRutCandidateSummary[]; blocked: RotRutBlockedSummary[] }
  | { ok: false; dbError: unknown }
> {
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*), customer:customers(id, name)')
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .eq('status', 'paid')
    .gt('deduction_total', 0)
    .order('paid_at', { ascending: true })

  if (error) return { ok: false, dbError: error }

  const { data: activeItems, error: activeError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, request:rot_rut_payout_requests!inner(id, status, company_id)')
    .eq('request.company_id', companyId)
    .not('request.status', 'in', '("cancelled","rejected")')

  if (activeError) return { ok: false, dbError: activeError }
  const activeInvoiceIds = new Set((activeItems ?? []).map((r) => r.invoice_id))

  const eligible: RotRutCandidateSummary[] = []
  const blocked: RotRutBlockedSummary[] = []

  for (const invoice of (invoices ?? []) as unknown as InvoiceWithCustomer[]) {
    if (activeInvoiceIds.has(invoice.id)) continue

    const result = evaluateInvoiceForFile(type, invoice)
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
    } else if (result.blocker.code !== 'NO_DEDUCTION_OF_TYPE') {
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
  const today = params.today ?? new Date().toISOString().slice(0, 10)
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
