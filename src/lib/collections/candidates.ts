import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { CollectionConnectionRow } from './connection'
import { evaluateEligibility, type Eligibility, type EligibilityBlockCode } from './eligibility'
import { deliveryEvidence, isClosedPaid, toHandoverCustomer, type HandoverInvoice } from './readiness'

/**
 * Overdue invoices that could go to the collections provider, for the agent
 * read collections.candidates.list (and later the daily batch). The same
 * eligibility as the dialog, without two things that only the handover
 * itself does: the bank check (one bank query per invoice; it runs at
 * handover and refuses there) and the personnummer reveal (a consumer's
 * age is checked at handover). The daily batch (autopilot.ts) reads the
 * same scan with the facts behind each answer.
 */

export interface CollectionCandidate {
  invoice_id: string
  invoice_number: string | null
  customer_id: string | null
  customer_name: string | null
  due_date: string
  overdue_days: number
  claim_amount: number
  remaining_amount: number
  eligible: boolean
  blocks: EligibilityBlockCode[]
  /** Delivery or import attestation needed: only a person in the web UI can hand it over. */
  needs_attestation: boolean
}

export const CANDIDATE_SCAN_LIMIT = 200

export interface CandidateScanInput {
  companyId: string
  connection: Pick<CollectionConnectionRow, 'minimum_amount' | 'reminder_fee_terms_since'>
  features: CollectionsFeatures | null
  now?: Date
  /** Only invoices due on or before this date (YYYY-MM-DD); default every invoice past its due date. */
  dueOnOrBefore?: string
}

/** One overdue invoice with the facts its answer rests on. */
export interface CandidateScanRow {
  candidate: CollectionCandidate
  invoice: HandoverInvoice
  eligibility: Eligibility
  /** The invoice's open case, if any. */
  openCase: { id: string; stage: string; submission_status: string } | null
  /** The invoice came from another system (a provider migration). */
  imported: boolean
  /** customers.collections_excluded: "Skicka aldrig till inkasso". */
  customerExcluded: boolean
}

export async function listCollectionCandidates(
  db: Pick<SupabaseClient, 'from'>,
  input: CandidateScanInput & { includeIneligible?: boolean },
): Promise<CollectionCandidate[]> {
  const rows = await scanCollectionCandidates(db, input)
  return rows.filter((row) => row.candidate.eligible || input.includeIneligible).map((row) => row.candidate)
}

/** Every owed invoice past its due date (oldest first, at most CANDIDATE_SCAN_LIMIT), each with its eligibility. */
export async function scanCollectionCandidates(db: Pick<SupabaseClient, 'from'>, input: CandidateScanInput): Promise<CandidateScanRow[]> {
  const now = input.now ?? new Date()
  const today = todayIsoStockholm(now)
  const { companyId } = input
  let query = db
    .from('invoices')
    // One literal string, so the schema guard checks every column.
    .select(
      'id, company_id, customer_id, status, document_type, credited_invoice_id, is_self_billed, currency, invoice_number, invoice_date, due_date, total, vat_amount, paid_amount, paid_at, remaining_amount, deduction_total, deduction_reclaimed_total, ore_rounding, payment_cash_account_id, your_reference, customer:customers(id, name, customer_type, country, address_line1, address_line2, postal_code, city, org_number, vat_number, customer_number, email, phone, collections_excluded)',
    )
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .is('credited_invoice_id', null)
    .in('status', ['sent', 'overdue', 'partially_paid'])
    .lt('due_date', today)
  if (input.dueOnOrBefore) query = query.lte('due_date', input.dueOnOrBefore)
  const { data, error } = await query.order('due_date', { ascending: true }).limit(CANDIDATE_SCAN_LIMIT)
  if (error) throw new Error(`invoice candidates lookup failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<HandoverInvoice & { customer: Record<string, unknown> | Record<string, unknown>[] | null }>
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const [settings, cases, creditNotes, emails, peppol, migrated, reminders] = await Promise.all([
    db.from('company_settings').select('ore_rounding').eq('company_id', companyId).maybeSingle(),
    db
      .from('collection_cases')
      .select('id, invoice_id, stage, is_open, submission_status, created_at')
      .eq('company_id', companyId)
      .in('invoice_id', ids),
    db.from('invoices').select('credited_invoice_id, status').eq('company_id', companyId).in('credited_invoice_id', ids).neq('status', 'cancelled'),
    db.from('invoice_deliveries').select('invoice_id, status, provider_status').eq('company_id', companyId).in('invoice_id', ids),
    db.from('peppol_deliveries').select('invoice_id, status').eq('company_id', companyId).in('invoice_id', ids),
    db.from('migration_source_records').select('target_id').eq('company_id', companyId).eq('resource', 'salesInvoices').in('target_id', ids),
    db.from('invoice_reminders').select('invoice_id, response_type').in('invoice_id', ids).not('response_type', 'is', null),
  ])
  for (const [label, result] of [
    ['company_settings', settings],
    ['collection_cases', cases],
    ['credit notes', creditNotes],
    ['invoice_deliveries', emails],
    ['peppol_deliveries', peppol],
    ['migration_source_records', migrated],
    ['invoice_reminders', reminders],
  ] as const) {
    if (result.error) throw new Error(`${label} lookup failed: ${result.error.message}`)
  }
  const group = <T extends Record<string, unknown>>(list: T[] | null, key: keyof T) => {
    const map = new Map<string, T[]>()
    for (const item of list ?? []) {
      const k = String(item[key])
      map.set(k, [...(map.get(k) ?? []), item])
    }
    return map
  }
  type CaseRow = { id: string; invoice_id: string; stage: string; is_open: boolean; submission_status: string; created_at: string }
  const caseRows = (cases.data ?? []) as CaseRow[]
  const casesBy = group(caseRows.filter((c) => c.is_open), 'invoice_id')
  // The latest registered case per invoice: one the provider closed as paid
  // blocks a second handover until the collected payment is booked.
  const latestRegisteredBy = new Map<string, CaseRow>()
  for (const row of caseRows) {
    if (row.submission_status !== 'registered') continue
    const seen = latestRegisteredBy.get(row.invoice_id)
    if (!seen || row.created_at > seen.created_at) latestRegisteredBy.set(row.invoice_id, row)
  }
  const creditsBy = group((creditNotes.data ?? []) as { credited_invoice_id: string; status: string }[], 'credited_invoice_id')
  const emailsBy = group((emails.data ?? []) as { invoice_id: string; status: string; provider_status: string | null }[], 'invoice_id')
  const peppolBy = group((peppol.data ?? []) as { invoice_id: string; status: string }[], 'invoice_id')
  const migratedIds = new Set(((migrated.data ?? []) as { target_id: string }[]).map((m) => m.target_id))
  const remindersBy = group((reminders.data ?? []) as { invoice_id: string; response_type: string }[], 'invoice_id')
  const oreRounding = (settings.data as { ore_rounding?: boolean | null } | null)?.ore_rounding ?? null

  const out: CandidateScanRow[] = []
  for (const raw of rows) {
    const customerRow = Array.isArray(raw.customer) ? (raw.customer[0] ?? null) : raw.customer
    const invoice: HandoverInvoice = {
      ...raw,
      total: Number(raw.total),
      vat_amount: Number(raw.vat_amount),
      paid_amount: raw.paid_amount === null ? null : Number(raw.paid_amount),
      remaining_amount: Number(raw.remaining_amount),
      deduction_total: raw.deduction_total === null ? null : Number(raw.deduction_total),
      deduction_reclaimed_total: raw.deduction_reclaimed_total === null ? null : Number(raw.deduction_reclaimed_total),
    }
    const responses = (remindersBy.get(raw.id) ?? []).map((r) => r.response_type)
    const open = casesBy.get(raw.id)?.[0] ?? null
    const eligibility = evaluateEligibility({
      invoice,
      customer: toHandoverCustomer(customerRow, { status: 'none' }),
      today,
      companyOreRounding: oreRounding,
      connection: input.connection,
      features: input.features,
      openCase: open ? { id: open.id, stage: open.stage } : null,
      latestCaseClosedPaid: isClosedPaid(latestRegisteredBy.get(raw.id)),
      creditNotes: creditsBy.get(raw.id) ?? [],
      delivery: deliveryEvidence({ emailDeliveries: emailsBy.get(raw.id) ?? [], peppolDeliveries: peppolBy.get(raw.id) ?? [] }),
      imported: migratedIds.has(raw.id),
      reminderResponse: responses.includes('disputed') ? 'disputed' : responses.includes('marked_paid') ? 'marked_paid' : null,
    })
    const candidate: CollectionCandidate = {
      invoice_id: raw.id,
      invoice_number: raw.invoice_number,
      customer_id: raw.customer_id,
      customer_name: (customerRow?.name as string | undefined) ?? null,
      due_date: raw.due_date,
      overdue_days: eligibility.overdueDays,
      claim_amount: eligibility.claim.amount,
      remaining_amount: eligibility.claim.remaining,
      eligible: eligibility.eligible,
      blocks: eligibility.blocks.map((b) => b.code),
      needs_attestation: eligibility.deliveryAttestation !== null || eligibility.responseAttestation !== null,
    }
    out.push({
      candidate,
      invoice,
      eligibility,
      openCase: open ? { id: open.id, stage: open.stage, submission_status: open.submission_status } : null,
      imported: migratedIds.has(raw.id),
      customerExcluded: customerRow?.collections_excluded === true,
    })
  }
  return out
}
