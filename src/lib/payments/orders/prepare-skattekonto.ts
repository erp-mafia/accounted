/**
 * Prepare a bank payment to the skattekonto: one draft payment order that
 * pays Skatteverket's bankgiro 5050-1055 with the company's OCR number, from
 * one of the company's own accounts.
 *
 * What it pays by default is what Hem asks for (listSkattekontoPaymentDue):
 * the next charge the synced saldo does not cover, less the bank payments
 * already on their way. Named from a declaration (source: a momsdeklaration
 * or an AGI, skattekonto-sources.ts), it pays what that declaration asks
 * for, by its due date, and the synced saldo is shown, never netted. The
 * person may pay in another amount. The day defaults to the last banking day
 * before Skatteverket draws the charge, so the money is on the skattekonto
 * by the due date; a day on or after it is allowed with a warning, because
 * Skatteverket charges interest (kostnadsränta) on what is missing.
 *
 * Everything else follows the supplier payment (prepare.ts): the same door,
 * the sandbox refusal, the same debtor, a draft nobody approved replaced by
 * the new one, and a service-role RPC, create_skattekonto_payment_order, that
 * sets the payee itself. Nothing reaches the bank here: a person approves the
 * draft and signs it with BankID. In v1 nothing books the debit when it
 * arrives: the bank row is booked the normal way, against the skattekonto
 * account.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { parseEntityType } from '@/lib/company/entity-type'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { earliestExecutionDateIso, executionDateFor, previousBankDayIso } from '@/lib/payments/bank-days'
import { formatPayeeLabel } from '@/lib/payments/supplier-payee'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { readReportedSkattekontoSaldo, resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { createServiceClient } from '@/lib/supabase/server'
import { listSkattekontoPaymentDue } from '@/lib/worklist/categories'
import { loadDebtor } from './debtor'
import { resolveSkattekontoSource, type SkattekontoPaymentSource, type SkattekontoSourceDue } from './skattekonto-sources'
import { openPaymentsDoor } from './switched-on'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

/** The name every skattekonto order carries as its payee (set by create_skattekonto_payment_order). */
export const SKATTEKONTO_PAYEE_NAME = 'Skatteverket'

/**
 * An open skattekonto order: from the draft until the bank accepted it. The
 * database allows one per company (uq_payment_orders_open_skattekonto_per_company).
 */
export const OPEN_SKATTEKONTO_ORDER_STATUSES = [
  'draft',
  'approved',
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
] as const

export interface PrepareSkattekontoPaymentInput {
  cashAccountId: string
  /** What to pay in, in kronor and öre. Defaults to what the skattekonto lacks for the next charge. */
  amount?: number | null
  /** YYYY-MM-DD. Defaults to the last banking day before Skatteverket draws the next charge. */
  executionDate?: string | null
  /** YYYY-MM-DD in Stockholm; injected so tests and the preview agree. */
  today: string
  /** The declaration paid: its amount and due date replace the next charge's. */
  source?: SkattekontoPaymentSource | null
  /** Run every check and answer the payment that would be created, without writing anything. The dialog's preview. */
  dryRun?: boolean
}

export interface SkattekontoPaymentWarning {
  /**
   * late: the payment day is on or after the day Skatteverket draws the charge.
   * date_moved: the day asked for is no banking day the bank takes, so it moved to the next one.
   * not_filed: the declaration paid is not on record as filed with Skatteverket.
   * possible_duplicate: a bank payment to the skattekonto of the same amount
   * was executed since the declaration's period, and may already pay it.
   */
  code: 'late' | 'date_moved' | 'not_filed' | 'possible_duplicate'
  /** For late: the day Skatteverket draws. */
  due?: string
  /** For date_moved: the day asked for and the banking day it became. */
  from?: string
  to?: string
  /** For possible_duplicate: the executed order and when the bank paid it. */
  payment_order_id?: string
  executed_at?: string | null
}

export interface PrepareSkattekontoPaymentResult {
  order: PaymentOrderRow
  warnings: SkattekontoPaymentWarning[]
  /** A skattekonto draft nobody approved, cancelled here so the person's latest choice wins. */
  replaced_draft_ids: string[]
  /** The declaration paid, when the payment was named from one. */
  source: SkattekontoSourceDue | null
  /** With a source: the saldo Skatteverket last reported, as information; never netted. */
  balance: SkattekontoBalance | null
}

/** The synced skattekonto saldo (positive = money on the account) and when it was fetched. */
export interface SkattekontoBalance {
  saldo: number
  fetched_at: string | null
}

/**
 * A bank payment to the skattekonto the bank executed since `since` for
 * exactly `amount`: it may already pay the declaration. Executed only: an
 * open one is the one payment at a time the checks above already hold to.
 */
async function executedPaymentLike(
  supabase: SupabaseClient,
  companyId: string,
  amount: number,
  since: string,
): Promise<{ id: string; executed_at: string | null } | null> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select('id, amount, executed_at')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .eq('status', 'executed')
    .gte('created_at', since)
  if (error) throw error
  const rows = (data ?? []) as Array<{ id: string; amount: number | string; executed_at: string | null }>
  return rows.find((row) => roundOre(Number(row.amount)) === amount) ?? null
}

const RPC_CODES: Record<string, string> = {
  sandbox: 'PAYMENTS_UNAVAILABLE',
  already_in_payment: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
  idempotency_mismatch: 'PAYMENT_ORDERS_IDEMPOTENCY_MISMATCH',
  invalid_payload: 'VALIDATION_ERROR',
}

/**
 * The OCR number for the payment: the one Skatteverket reported with the
 * synced saldo, else the one derived from the org number (resolveSkattekontoOcr).
 * A reported OCR needs no org number, so the derivation is only asked when
 * there is none; null when neither exists.
 */
async function skattekontoOcr(supabase: SupabaseClient, companyId: string, log: Logger): Promise<string | null> {
  const { data, error } = await supabase.from('companies').select('org_number, entity_type').eq('id', companyId).maybeSingle()
  if (error) throw error
  const company = data as { org_number: string | null; entity_type: string | null } | null
  try {
    // The form decides whether the redovisare is built from a personnummer
    // (toRedovisare12); an unknown one throws, never defaults.
    return await resolveSkattekontoOcr(supabase, companyId, company?.org_number ?? '', parseEntityType(company?.entity_type))
  } catch (err) {
    log.warn('skattekonto payment: no OCR number', { companyId, reason: (err as { message?: string })?.message })
    return null
  }
}

export async function prepareSkattekontoPaymentOrder(
  ctx: OperationContext,
  input: PrepareSkattekontoPaymentInput,
): Promise<OperationOutcome<PrepareSkattekontoPaymentResult>> {
  const { supabase, companyId, userId, log } = ctx
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  // Never from the sandbox: a demo visitor must not reach a real bank.
  if (await isSandboxCompany(supabase, companyId)) {
    return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: 'sandbox' } }
  }
  if (input.executionDate && input.executionDate < input.today) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'execution_date', reason: 'in_the_past' } }
  }
  const chosenAmount = input.amount === null || input.amount === undefined ? null : roundOre(Number(input.amount))
  if (chosenAmount !== null && !(chosenAmount > 0)) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount', reason: 'not_positive' } }
  }

  const debtor = await loadDebtor(supabase, companyId, input.cashAccountId)
  if (!debtor.ok) return { ok: false, code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE', details: { reason: debtor.reason } }

  // One skattekonto payment at a time. A draft nobody approved does not
  // block: it is replaced below, so a second Betala via banken never fails on
  // the first one's leftovers. Anything further along is in payment already.
  const { data: openData, error: openError } = await supabase
    .from('payment_orders')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .in('status', [...OPEN_SKATTEKONTO_ORDER_STATUSES])
  if (openError) throw openError
  const open = (openData ?? []) as Array<{ id: string; status: string }>
  const inPayment = open.find((o) => o.status !== 'draft')
  if (inPayment) {
    return { ok: false, code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT', details: { payment_order_id: inPayment.id, status: inPayment.status } }
  }
  const staleDraftIds = open.filter((o) => o.status === 'draft').map((o) => o.id)

  // A declaration names its own amount and due date. Without one, what Hem
  // asks for: the next charge, the shortfall against the saldo, and the bank
  // payments already covering part of it.
  let source: SkattekontoSourceDue | null = null
  if (input.source) {
    const resolved = await resolveSkattekontoSource(supabase, companyId, input.source, input.today)
    if (!resolved.ok) return { ok: false, code: resolved.code, details: resolved.details }
    source = resolved.due
  }
  const due = source ? null : await listSkattekontoPaymentDue(supabase, companyId, input.today)
  const amount = chosenAmount ?? (source ? source.payable : (due?.amount ?? null))
  if (amount === null) {
    if (!source) return { ok: false, code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE' }
    return {
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
      details: { reason: source.nothing_due, declared: source.declared, tax_period: source.tax_period },
    }
  }
  const dueDate = source ? source.due_date : (due?.due ?? null)

  const ocr = due?.ocr ?? (await skattekontoOcr(supabase, companyId, log))
  if (!ocr) return { ok: false, code: 'SKATTEKONTO_PAYMENT_OCR_MISSING' }

  // The bank takes a banking day from tomorrow on. By default the money
  // leaves the banking day before Skatteverket draws, so it is on the
  // skattekonto by the due date; without a charge to pay towards, the
  // earliest day the bank takes.
  const wantedDate = input.executionDate ?? (dueDate ? previousBankDayIso(dueDate) : earliestExecutionDateIso(input.today))
  const executionDate = executionDateFor(wantedDate, input.today)
  const warnings: SkattekontoPaymentWarning[] = []
  if (input.executionDate && executionDate !== input.executionDate) {
    warnings.push({ code: 'date_moved', from: input.executionDate, to: executionDate })
  }
  if (dueDate && executionDate >= dueDate) warnings.push({ code: 'late', due: dueDate })
  let balance: SkattekontoBalance | null = null
  if (source) {
    if (!source.filed) warnings.push({ code: 'not_filed' })
    const paid = await executedPaymentLike(supabase, companyId, amount, source.paid_from)
    if (paid) warnings.push({ code: 'possible_duplicate', payment_order_id: paid.id, executed_at: paid.executed_at })
    const reported = await readReportedSkattekontoSaldo(supabase, companyId)
    balance = reported ? { saldo: roundOre(reported.saldo), fetched_at: reported.fetched_at } : null
  }

  const bankgiro = SKATTEKONTO_BANKGIRO.replace(/\D/g, '')
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        cash_account_id: input.cashAccountId,
        debtor: { bank_name: debtor.debtor.bank_name, bic: debtor.debtor.bic },
        amount,
        currency: debtor.debtor.currency,
        requested_execution_date: executionDate,
        date_moved_from: input.executionDate && executionDate !== input.executionDate ? input.executionDate : null,
        due: due ? { date: due.due, charge: due.charge, balance: due.balance, amount: due.amount } : null,
        source,
        balance,
        payee: { type: 'bankgiro', label: formatPayeeLabel({ type: 'bankgiro', bankgiro }), name: SKATTEKONTO_PAYEE_NAME },
        reference: { type: 'ocr', value: ocr },
        warnings,
        replaces_drafts: staleDraftIds.length,
      },
    }
  }

  const writer = createServiceClient()
  let replaced: string[] = []
  if (staleDraftIds.length > 0) {
    // The database refuses a second open skattekonto order, so the stale
    // draft goes first. Only drafts: the status filter keeps anything a
    // person approved meanwhile out of reach.
    const { data: cancelled, error: cancelError } = await writer
      .from('payment_orders')
      .update({ status: 'cancelled', cancelled_by: userId, cancelled_at: new Date().toISOString() })
      .in('id', staleDraftIds)
      .eq('company_id', companyId)
      .eq('purpose', 'skattekonto')
      .eq('status', 'draft')
      .select('id')
    if (cancelError) throw cancelError
    replaced = ((cancelled ?? []) as Array<{ id: string }>).map((o) => o.id)
    if (replaced.length > 0) {
      await logPaymentOrderEvents(
        writer,
        replaced.map((id) => ({
          company_id: companyId,
          payment_order_id: id,
          event_type: 'cancelled',
          from_status: 'draft',
          to_status: 'cancelled',
          actor_user_id: userId,
          detail: { replaced_by_new_draft: true },
        })),
        log,
      )
    }
  }

  const { data: rpc, error: rpcError } = await writer.rpc('create_skattekonto_payment_order', {
    p_company_id: companyId,
    p_cash_account_id: input.cashAccountId,
    p_debtor_snapshot: debtor.debtor,
    p_amount: amount,
    p_requested_execution_date: executionDate,
    p_reference: ocr,
    p_idempotency_key: randomUUID(),
    p_user_id: userId,
  })
  if (rpcError) throw rpcError
  const result = rpc as { ok: boolean; code?: string; details?: unknown; order?: PaymentOrderRow }
  if (!result.ok || !result.order) {
    log.warn('create_skattekonto_payment_order refused', { code: result.code })
    return {
      ok: false,
      code: RPC_CODES[result.code ?? ''] ?? 'UNKNOWN_ERROR',
      details: { rpc_code: result.code, rpc_details: result.details as Record<string, unknown> | undefined },
    }
  }
  return { ok: true, data: { order: result.order, warnings, replaced_draft_ids: replaced, source, balance } }
}
