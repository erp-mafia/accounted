/**
 * Changed supplier bank details, from the invoice's arrival to its payment.
 *
 * The rules are pure (./payee-change.ts); this module reads what they need
 * and records what a person decided:
 *
 *   - assessRegisteredPayee (./payee-registration.ts): every supplier
 *     invoice create path asks it, after it read what the document states
 *     and before it touches the supplier card. An invoice that alerts never
 *     backfills the card: the backfill fills columns the card lacks, and a
 *     new bankgiro on a card that pays a plusgiro would silently become the
 *     card's payment account.
 *   - loadPayeeHolds: what holds a payment back, for the payment file, the
 *     bank payment preparation, the worklist and the lists. Derived every
 *     time from the invoice, the card and the decisions, never stored, so an
 *     edited card, a later invoice and every create path agree.
 *   - decideSupplierPayee: a person's confirmation or rejection, kept in
 *     supplier_payee_confirmations per supplier and account, so one
 *     confirmation covers every later invoice with the same account.
 *
 * Nothing here pays or blocks by itself: batch-eligibility turns a hold into
 * the exclusion reasons payee_unconfirmed and payee_rejected.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { SupplierPayeeChangeDue } from '@/lib/worklist/types'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from './batch-eligibility'
import {
  cardColumnsForKey,
  classifyPayeeChange,
  payeeAlertFor,
  payeeHoldFor,
  payeeKeyLabel,
  type CardPayeeSource,
  type PayeeAlert,
  type PayeeChangeKind,
  type PayeeDecision,
  type PayeeHold,
  type StatedPayeeSource,
} from './payee-change'

/** The supplier card columns the rules read. */
export const CARD_PAYEE_COLUMNS = 'bankgiro, plusgiro, bank_account, clearing_number, account_number, iban'

/** The invoice columns the rules read. */
export const STATED_PAYEE_COLUMNS = 'payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban'

/** An invoice the company has paid in whole or in part: the supplier has been paid somewhere before. */
const PAID_STATUSES = ['paid', 'partially_paid'] as const

export interface PayeeInvoiceFacts extends StatedPayeeSource {
  id: string
  supplier_id: string
}

export interface PayeeAlertState {
  alert: PayeeAlert
  decision: PayeeDecision | null
  hold: PayeeHold | null
  stated_key: string
  card_key: string | null
}

interface DecisionRow {
  supplier_id: string
  payee_key: string
  decision: PayeeDecision
  decided_at: string
}

/** The latest decision per supplier and account. */
async function loadDecisions(
  supabase: SupabaseClient,
  companyId: string,
  supplierIds: string[],
): Promise<Map<string, PayeeDecision>> {
  const latest = new Map<string, PayeeDecision>()
  if (supplierIds.length === 0) return latest
  const { data, error } = await supabase
    .from('supplier_payee_confirmations')
    .select('supplier_id, payee_key, decision, decided_at')
    .eq('company_id', companyId)
    .in('supplier_id', supplierIds)
    .order('decided_at', { ascending: false })
  if (error) throw error
  for (const row of (data ?? []) as DecisionRow[]) {
    const key = `${row.supplier_id}|${row.payee_key}`
    if (!latest.has(key)) latest.set(key, row.decision)
  }
  return latest
}

/** Suppliers with a paid invoice other than the ones asked about. */
export async function loadPaidSuppliers(
  supabase: SupabaseClient,
  companyId: string,
  supplierIds: string[],
  excludeInvoiceIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (supplierIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_id')
    .eq('company_id', companyId)
    .in('supplier_id', supplierIds)
    .in('status', [...PAID_STATUSES])
    .eq('is_credit_note', false)
    .limit(1000)
  if (error) throw error
  return new Set(
    ((data ?? []) as Array<{ id: string; supplier_id: string }>)
      .filter((row) => !excludeInvoiceIds.has(row.id))
      .map((row) => row.supplier_id),
  )
}

/**
 * What alerts on each invoice, and what holds its payment back. Invoices
 * without an alert are absent from the map. `cards` are the supplier cards
 * by supplier id: a supplier missing there reads as an empty card.
 */
export async function loadPayeeHolds(
  supabase: SupabaseClient,
  companyId: string,
  invoices: readonly PayeeInvoiceFacts[],
  cards: ReadonlyMap<string, CardPayeeSource>,
): Promise<Map<string, PayeeAlertState>> {
  const changes = invoices.map((invoice) => ({
    invoice,
    change: classifyPayeeChange({ invoice, card: cards.get(invoice.supplier_id) ?? {} }),
  }))
  const candidates = changes.filter((c) => c.change.kind === 'changed' || c.change.kind === 'new_supplier_account')
  const result = new Map<string, PayeeAlertState>()
  if (candidates.length === 0) return result

  const newAccountSuppliers = [
    ...new Set(candidates.filter((c) => c.change.kind === 'new_supplier_account').map((c) => c.invoice.supplier_id)),
  ]
  const paid = await loadPaidSuppliers(supabase, companyId, newAccountSuppliers, new Set(invoices.map((i) => i.id)))
  const alerting = candidates.flatMap((c) => {
    const alert = payeeAlertFor(c.change.kind, paid.has(c.invoice.supplier_id))
    return alert && c.change.statedKey ? [{ ...c, alert, statedKey: c.change.statedKey }] : []
  })
  if (alerting.length === 0) return result

  const decisions = await loadDecisions(supabase, companyId, [...new Set(alerting.map((c) => c.invoice.supplier_id))])
  for (const c of alerting) {
    const decision = decisions.get(`${c.invoice.supplier_id}|${c.statedKey}`) ?? null
    result.set(c.invoice.id, {
      alert: c.alert,
      decision,
      hold: payeeHoldFor(c.alert, decision),
      stated_key: c.statedKey,
      card_key: c.change.cardKey,
    })
  }
  return result
}

/**
 * The invoice's alert as the payment paths need it: the hold, or null when
 * nothing holds the payment back. Shared by the payment file and the bank
 * payment preparation so the two channels refuse the same invoices.
 */
export function holdFor(states: ReadonlyMap<string, PayeeAlertState>, invoiceId: string): PayeeHold | null {
  return states.get(invoiceId)?.hold ?? null
}

// ─────────────────────────────────────────────────────────────────
// Lists: the worklist and the markers
// ─────────────────────────────────────────────────────────────────

/** One row per invoice: the worklist's shape (lib/worklist/types.ts, client-safe). */
export type SupplierPayeeAlertRow = SupplierPayeeChangeDue

/** The unpaid invoices of the company whose stated account alerts, at most `cap`. */
export async function listSupplierPayeeAlerts(
  supabase: SupabaseClient,
  companyId: string,
  options: { cap?: number } = {},
): Promise<SupplierPayeeAlertRow[]> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select(
      `id, supplier_id, supplier_invoice_number, arrival_number, due_date, ${STATED_PAYEE_COLUMNS}, ` +
        `supplier:suppliers(id, name, ${CARD_PAYEE_COLUMNS})`,
    )
    .eq('company_id', companyId)
    .in('status', [...PAYABLE_SUPPLIER_INVOICE_STATUSES])
    .eq('is_credit_note', false)
    .gt('remaining_amount', 0)
    .or('payee_bankgiro.not.is.null,payee_plusgiro.not.is.null,payee_account.not.is.null,payee_iban.not.is.null')
    .order('due_date', { ascending: true })
    .limit(options.cap ?? 200)
  if (error) throw error
  type Row = PayeeInvoiceFacts & {
    supplier_invoice_number: string | null
    arrival_number: number | null
    due_date: string
    supplier: (CardPayeeSource & { id: string; name: string }) | null
  }
  const rows = (data ?? []) as unknown as Row[]
  const cards = new Map(rows.filter((r) => r.supplier).map((r) => [r.supplier_id, r.supplier as CardPayeeSource]))
  const states = await loadPayeeHolds(supabase, companyId, rows, cards)
  return rows.flatMap((row) => {
    const state = states.get(row.id)
    if (!state) return []
    return [
      {
        supplier_invoice_id: row.id,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier?.name ?? '',
        supplier_invoice_number: row.supplier_invoice_number,
        arrival_number: row.arrival_number,
        due_date: row.due_date,
        alert: state.alert,
        decision: state.decision,
        hold: state.hold,
        old_payee: state.card_key ? payeeKeyLabel(state.card_key) : null,
        new_payee: payeeKeyLabel(state.stated_key),
      },
    ]
  })
}

// ─────────────────────────────────────────────────────────────────
// One invoice: the detail page and the decision
// ─────────────────────────────────────────────────────────────────

export interface InvoicePayeeView {
  supplier_invoice_id: string
  supplier_id: string
  supplier_name: string
  kind: PayeeChangeKind
  alert: PayeeAlert | null
  decision: PayeeDecision | null
  hold: PayeeHold | null
  old_payee: string | null
  new_payee: string | null
  /** The giro the invoice states, for a Bankgiro lookup of the registered name; null for an account or IBAN. */
  new_payee_key: string | null
  last_decision: { decision: PayeeDecision; decided_at: string; note: string | null } | null
  /** Whether a payment could reach the invoice at all (unpaid, not a credit note). */
  payable: boolean
}

type InvoicePayeeRead =
  | { ok: true; view: InvoicePayeeView }
  | { ok: false; code: 'SI_NOT_FOUND' }

/** Everything the detail page shows about the invoice's stated account. */
export async function readInvoicePayee(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<InvoicePayeeRead> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select(`id, supplier_id, status, is_credit_note, remaining_amount, ${STATED_PAYEE_COLUMNS}, supplier:suppliers(id, name, ${CARD_PAYEE_COLUMNS})`)
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) return { ok: false, code: 'SI_NOT_FOUND' }
  const invoice = data as unknown as PayeeInvoiceFacts & {
    status: string
    is_credit_note: boolean
    remaining_amount: number
    supplier: (CardPayeeSource & { id: string; name: string }) | null
  }
  const card: CardPayeeSource = invoice.supplier ?? {}
  const change = classifyPayeeChange({ invoice, card })
  const states = await loadPayeeHolds(supabase, companyId, [invoice], new Map([[invoice.supplier_id, card]]))
  const state = states.get(invoice.id) ?? null

  let lastDecision: InvoicePayeeView['last_decision'] = null
  if (change.statedKey) {
    const { data: decided, error: decidedError } = await supabase
      .from('supplier_payee_confirmations')
      .select('decision, decided_at, note')
      .eq('company_id', companyId)
      .eq('supplier_id', invoice.supplier_id)
      .eq('payee_key', change.statedKey)
      .order('decided_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (decidedError) throw decidedError
    lastDecision = (decided as InvoicePayeeView['last_decision']) ?? null
  }

  return {
    ok: true,
    view: {
      supplier_invoice_id: invoice.id,
      supplier_id: invoice.supplier_id,
      supplier_name: invoice.supplier?.name ?? '',
      kind: change.kind,
      alert: state?.alert ?? null,
      decision: state?.decision ?? null,
      hold: state?.hold ?? null,
      old_payee: change.cardKey ? payeeKeyLabel(change.cardKey) : null,
      new_payee: change.statedKey ? payeeKeyLabel(change.statedKey) : null,
      new_payee_key: change.statedKey,
      last_decision: lastDecision,
      payable:
        !invoice.is_credit_note &&
        Number(invoice.remaining_amount) > 0 &&
        (PAYABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(invoice.status),
    },
  }
}

export interface DecideSupplierPayeeInput {
  supplierInvoiceId: string
  decision: PayeeDecision
  /** Confirm only: make the account the supplier card's payment account. */
  updateSupplierCard?: boolean
  note?: string | null
}

export interface DecideSupplierPayeeResult {
  supplier_invoice_id: string
  supplier_id: string
  decision: PayeeDecision
  payee: string
  supplier_card_updated: boolean
}

/**
 * Record a person's decision on the account an invoice states. Confirming
 * covers every invoice of the supplier that states the same account; with
 * updateSupplierCard the card pays it from now on. Rejecting holds every
 * payment of the supplier to that account until a person confirms it after
 * all or the card is changed to it. Refused when the invoice states no
 * account the company lacks: there is nothing to decide.
 */
export async function decideSupplierPayee(
  ctx: OperationContext,
  input: DecideSupplierPayeeInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DecideSupplierPayeeResult>> {
  const { supabase, companyId, userId, log } = ctx
  const read = await readInvoicePayee(supabase, companyId, input.supplierInvoiceId)
  if (!read.ok) return { ok: false, code: read.code }
  const view = read.view
  if (!view.alert || !view.new_payee_key) {
    return { ok: false, code: 'SUPPLIER_PAYEE_NOTHING_TO_DECIDE', details: { kind: view.kind } }
  }
  const updateCard = input.decision === 'confirmed' && input.updateSupplierCard !== false
  const cardColumns = updateCard ? cardColumnsForKey(view.new_payee_key) : null
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: view.supplier_invoice_id,
        supplier_id: view.supplier_id,
        supplier_name: view.supplier_name,
        decision: input.decision,
        current_supplier_account: view.old_payee,
        invoice_account: view.new_payee,
        alert: view.alert,
        previous_decision: view.decision,
        updates_supplier_card: cardColumns !== null,
      },
    }
  }

  // The card first: a failed card write leaves nothing decided, so the
  // person retries the whole decision instead of a half of it.
  if (cardColumns) {
    const { error: cardError } = await supabase
      .from('suppliers')
      .update(cardColumns)
      .eq('id', view.supplier_id)
      .eq('company_id', companyId)
    if (cardError) {
      log.warn('supplier card update for a payee confirmation failed', { supplierId: view.supplier_id, code: (cardError as { code?: string }).code })
      return { ok: false, code: 'SUPPLIER_PAYEE_DECISION_FAILED' }
    }
  }

  const { error: insertError } = await supabase.from('supplier_payee_confirmations').insert({
    company_id: companyId,
    supplier_id: view.supplier_id,
    payee_key: view.new_payee_key,
    decision: input.decision,
    decided_by: userId,
    source_supplier_invoice_id: view.supplier_invoice_id,
    note,
    supplier_card_updated: cardColumns !== null,
  })
  if (insertError) {
    log.error('supplier payee decision insert failed', insertError as unknown as Error)
    return { ok: false, code: 'SUPPLIER_PAYEE_DECISION_FAILED' }
  }

  return {
    ok: true,
    data: {
      supplier_invoice_id: view.supplier_invoice_id,
      supplier_id: view.supplier_id,
      decision: input.decision,
      payee: view.new_payee ?? '',
      supplier_card_updated: cardColumns !== null,
    },
  }
}
