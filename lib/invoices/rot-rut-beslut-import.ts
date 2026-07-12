import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { RotRutBeslutFileSchema } from '@/lib/api/schemas'
import { decryptPersonnummer } from '@/lib/salary/personnummer'

/**
 * Import of Skatteverkets beslutsfil for rot/rut (the decision JSON the user
 * downloads from the e-tjänst after SKV has processed a begäran om
 * utbetalning: dev_docs/skatteverket/husavdrag/exempel_beslut.json).
 *
 * Records godkänt belopp per ärende on the matching payout request so the
 * existing settle flow can book the actual utbetalning (including partial
 * approvals) without the user re-typing SKV's numbers.
 *
 * Matching is deterministic, never fuzzy (core principle: act only on exact
 * matches):
 *   - request: by previously stored skv_referensnummer (idempotent
 *     re-import), else by exact name (NamnPaBegaran round-trips through
 *     SKV's file unchanged). Ambiguity is an error, not a guess.
 *   - ärende -> item: by fakturanummer against the invoice number, else by
 *     the buyer's personnummer. Exactly one candidate or the beslut errors.
 *
 * A beslut applies all-or-nothing: if any ärende fails to match, nothing in
 * that beslut is written. Different beslut in the same file are independent.
 *
 * Settlement is deliberately NOT booked here: recording the beslut and
 * booking the bank payout are separate acts (the payout may not have landed
 * yet). The result carries a `next` hint pointing at the settle endpoint.
 */

export type RotRutBeslutFile = z.infer<typeof RotRutBeslutFileSchema>

export interface RotRutBeslutOutcome {
  namn: string
  referensnummer: string
  status: 'imported' | 'already_imported' | 'error'
  request_id?: string
  decided_total?: number
  items_updated?: number
  /** True when SKV approved 0 kr for every ärende (avslag). */
  rejected?: boolean
  error?: string
  next?: string
}

export type RotRutBeslutImportResult =
  | {
      ok: true
      results: RotRutBeslutOutcome[]
      imported: number
      already_imported: number
      errors: number
    }
  | { ok: false; code: 'ROT_RUT_BESLUT_WRONG_COMPANY' | 'ROT_RUT_FILE_CREATE_FAILED' }

interface RequestRow {
  id: string
  name: string
  status: string
  requested_total: number
  decided_total: number | null
  decided_at: string | null
  skv_referensnummer: string | null
}

interface ItemRow {
  id: string
  invoice_id: string
  requested_amount: number
  invoice: {
    invoice_number: string | number | null
    deduction_personnummer_encrypted: string | null
  } | null
}

/** Normalize an org number to SKV's 12-digit form (16-prefixed). */
function normalizeOrgNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `16${digits}` : digits
}

const SETTLE_HINT = 'POST /api/rot-rut/payout-requests/{request_id}/settle bokför utbetalningen när den landat på banken.'

export async function importRotRutBeslutFile(
  supabase: SupabaseClient,
  companyId: string,
  file: RotRutBeslutFile
): Promise<RotRutBeslutImportResult> {
  // Hard company check: a beslutsfil for another utförare must never touch
  // this company's requests.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, code: 'ROT_RUT_FILE_CREATE_FAILED' }

  const orgNumber = (settings?.org_number as string | null) ?? null
  if (!orgNumber || normalizeOrgNumber(orgNumber) !== normalizeOrgNumber(file.utforare)) {
    return { ok: false, code: 'ROT_RUT_BESLUT_WRONG_COMPANY' }
  }

  const { data: requests, error: requestsError } = await supabase
    .from('rot_rut_payout_requests')
    .select('id, name, status, requested_total, decided_total, decided_at, skv_referensnummer')
    .eq('company_id', companyId)
  if (requestsError) return { ok: false, code: 'ROT_RUT_FILE_CREATE_FAILED' }

  const allRequests = (requests ?? []) as RequestRow[]
  const results: RotRutBeslutOutcome[] = []

  for (const beslut of file.beslut) {
    results.push(await applyBeslut(supabase, allRequests, beslut))
  }

  return {
    ok: true,
    results,
    imported: results.filter((r) => r.status === 'imported').length,
    already_imported: results.filter((r) => r.status === 'already_imported').length,
    errors: results.filter((r) => r.status === 'error').length,
  }
}

async function applyBeslut(
  supabase: SupabaseClient,
  allRequests: RequestRow[],
  beslut: RotRutBeslutFile['beslut'][number]
): Promise<RotRutBeslutOutcome> {
  const base = { namn: beslut.namn, referensnummer: beslut.referensnummer }

  // 1. Resolve the request. Referensnummer wins (set by a previous import of
  //    the same beslut); name matching only considers undecided, active
  //    requests without a stored referensnummer.
  const byRef = allRequests.filter((r) => r.skv_referensnummer === beslut.referensnummer)
  let request: RequestRow | null = byRef[0] ?? null

  if (request?.decided_at) {
    return { ...base, status: 'already_imported', request_id: request.id }
  }

  if (!request) {
    const byName = allRequests.filter(
      (r) =>
        r.name === beslut.namn &&
        r.skv_referensnummer === null &&
        ['generated', 'submitted'].includes(r.status)
    )
    if (byName.length === 0) {
      return {
        ...base,
        status: 'error',
        error: `Ingen aktiv begäran med namnet "${beslut.namn}" hittades.`,
      }
    }
    if (byName.length > 1) {
      return {
        ...base,
        status: 'error',
        error: `Flera begäran har namnet "${beslut.namn}": beslutet kan inte matchas entydigt.`,
      }
    }
    request = byName[0]
    if (request.decided_at) {
      return { ...base, status: 'already_imported', request_id: request.id }
    }
  }

  // 2. Load the request's items with the invoice keys used for matching.
  const { data: itemRows, error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .select(
      'id, invoice_id, requested_amount, invoice:invoices(invoice_number, deduction_personnummer_encrypted)'
    )
    .eq('request_id', request.id)
  if (itemsError) {
    return { ...base, status: 'error', request_id: request.id, error: itemsError.message }
  }

  const items = ((itemRows ?? []) as unknown as ItemRow[]).map((item) => {
    let personnummer: string | null = null
    if (item.invoice?.deduction_personnummer_encrypted) {
      try {
        personnummer = decryptPersonnummer(item.invoice.deduction_personnummer_encrypted).replace(/\D/g, '')
      } catch {
        personnummer = null
      }
    }
    return {
      ...item,
      invoiceNumber: item.invoice?.invoice_number != null ? String(item.invoice.invoice_number) : null,
      personnummer,
    }
  })

  // 3. Match every ärende to exactly one item (all-or-nothing per beslut).
  const consumed = new Set<string>()
  const matches: Array<{ itemId: string; godkantBelopp: number }> = []
  for (const arende of beslut.arenden) {
    const available = items.filter((i) => !consumed.has(i.id))
    let candidates = arende.fakturanummer
      ? available.filter((i) => i.invoiceNumber === arende.fakturanummer)
      : []
    if (candidates.length !== 1) {
      candidates = available.filter((i) => i.personnummer === arende.personnummer)
    }
    if (candidates.length !== 1) {
      return {
        ...base,
        status: 'error',
        request_id: request.id,
        error:
          `Ärendet (personnummer ...${arende.personnummer.slice(-4)}` +
          `${arende.fakturanummer ? `, faktura ${arende.fakturanummer}` : ''}) ` +
          `matchar ${candidates.length === 0 ? 'ingen' : 'flera'} fakturor i begäran. Inget har importerats.`,
      }
    }
    consumed.add(candidates[0].id)
    matches.push({ itemId: candidates[0].id, godkantBelopp: arende.godkantBelopp })
  }

  // 4. Apply atomically: per-item decided amounts plus the request header go
  //    through one RPC (apply_rot_rut_beslut) so a mid-sequence failure can
  //    never leave some items decided but the header untouched (or vice
  //    versa). The function raises on any missing row, rolling back the
  //    whole beslut.
  const decidedTotal = matches.reduce((sum, m) => sum + m.godkantBelopp, 0)
  const rejected = decidedTotal === 0
  // A beslut proves the file was submitted; 0 kr approved on every ärende is
  // an avslag. Settle (paid/partially_paid) stays a separate, explicit act.
  const newStatus = rejected
    ? 'rejected'
    : request.status === 'generated'
      ? 'submitted'
      : request.status
  const { error: applyError } = await supabase.rpc('apply_rot_rut_beslut', {
    p_request_id: request.id,
    p_items: matches.map((m) => ({ item_id: m.itemId, decided_amount: m.godkantBelopp })),
    p_decided_total: decidedTotal,
    p_skv_referensnummer: beslut.referensnummer,
    p_new_status: newStatus,
  })
  if (applyError) {
    return { ...base, status: 'error', request_id: request.id, error: applyError.message }
  }

  // Keep the shared in-memory request list in sync with what was just
  // written: a later beslut in the same file (same name, different
  // referensnummer) must see this request as decided instead of re-applying
  // a second decision on top of the first.
  request.skv_referensnummer = beslut.referensnummer
  request.decided_at = new Date().toISOString()
  request.decided_total = decidedTotal
  request.status = newStatus

  return {
    ...base,
    status: 'imported',
    request_id: request.id,
    decided_total: decidedTotal,
    items_updated: matches.length,
    rejected,
    next: rejected ? undefined : SETTLE_HINT.replace('{request_id}', request.id),
  }
}
