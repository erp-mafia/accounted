/**
 * Prepare a bank payment to the skattekonto: one draft payment order that
 * pays Skatteverket's bankgiro 5050-1055 with the company's OCR number, from
 * one of the company's own accounts.
 *
 * What it pays by default is what Hem asks for (listSkattekontoPaymentDue):
 * the next charge the synced saldo does not cover, less the bank payments
 * already on their way. Named from a declaration (source: a momsdeklaration
 * or an AGI, skattekonto-sources.ts), it pays what that declaration asks
 * for, by its due date, and the synced saldo is shown, never netted. Named
 * from a day (source due_date), it pays everything declared due that day as
 * one payment. The database holds one open skattekonto order per execution
 * day: a payment for a day whose order nobody has signed yet is added to it
 * (the total is approved again), a day whose order is signed or at the bank
 * refuses, and another day gets its own order (crm#1485). A declaration paid
 * on its own warns when another one is due the same day. The person may pay in
 * another amount. The day defaults to the last banking day before
 * Skatteverket draws the charge, so the money is on the skattekonto by the
 * due date; a day on or after it is allowed with a warning, because
 * Skatteverket charges interest (kostnadsränta) on what is missing.
 *
 * Everything else follows the supplier payment (prepare.ts): the same door,
 * the sandbox refusal, the same debtor, and a service-role RPC,
 * create_skattekonto_payment_order, that sets the payee itself. Nothing reaches the bank here: a person approves the
 * draft and signs it with BankID. In v1 nothing books the debit when it
 * arrives: the bank row is booked the normal way, against the skattekonto
 * account.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { parseEntityType } from '@/lib/company/entity-type'
import { readCompanyOrgNumber } from '@/lib/company/org-number'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { earliestExecutionDateIso, executionDateFor } from '@/lib/payments/bank-days'
import { formatPayeeLabel } from '@/lib/payments/supplier-payee'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { readReportedSkattekontoSaldo, resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { createServiceClient } from '@/lib/supabase/server'
import { listSkattekontoPaymentDue } from '@/lib/worklist/categories'
import { loadDebtor } from './debtor'
import {
  resolveSkattekontoDueDate,
  resolveSkattekontoSource,
  type SkattekontoDeclarationSource,
  type SkattekontoDueDateComponent,
  type SkattekontoDueDateDue,
  type SkattekontoPaymentSource,
  type SkattekontoSourceDue,
} from './skattekonto-sources'
import { openPaymentsDoor } from './switched-on'
import type { PaymentOrderRow } from './types'
import { isSkattekontoDayInPayment, readOpenSkattekontoOrderOnDay, skattekontoPaymentDayFor } from './skattekonto-day'

/** The name every skattekonto order carries as its payee (set by create_skattekonto_payment_order). */
export const SKATTEKONTO_PAYEE_NAME = 'Skatteverket'

export interface PrepareSkattekontoPaymentInput {
  cashAccountId: string
  /** What to pay in, in kronor and öre. Defaults to what the skattekonto lacks for the next charge. */
  amount?: number | null
  /** YYYY-MM-DD. Defaults to the last banking day before Skatteverket draws the next charge. */
  executionDate?: string | null
  /** YYYY-MM-DD in Stockholm; injected so tests and the preview agree. */
  today: string
  /** The declaration paid, or the day whose declarations are paid: its amount and due date replace the next charge's. */
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
   * same_due_date_parts: another declaration is due the same day as the one
   * paid; the combined source (due_date) pays them all as one payment.
   */
  code: 'late' | 'date_moved' | 'not_filed' | 'possible_duplicate' | 'same_due_date_parts'
  /** For late: the day Skatteverket draws. */
  due?: string
  /** For date_moved: the day asked for and the banking day it became. */
  from?: string
  to?: string
  /** For possible_duplicate: the executed order and when the bank paid it. */
  payment_order_id?: string
  executed_at?: string | null
  /** For not_filed and possible_duplicate on a payment of several declarations: the declaration meant. */
  source?: 'vat_declaration' | 'agi'
  period?: string
  /** For same_due_date_parts (due is the day): the other declarations due that day that ask for a payment. */
  parts?: SkattekontoDueDateComponent[]
  /** For same_due_date_parts: everything declared due that day, this declaration included. */
  total?: number
  /** For same_due_date_parts: a draft nobody approved is replaced by this payment (it may pay one of the parts). */
  replaces_draft?: boolean
  /** For same_due_date_parts: the source that pays every part as one payment. */
  suggested_source?: { source: 'due_date'; due_date: string }
}

/** The open order of the same execution day the payment is added to: its amount before, and the total after. */
export interface SkattekontoMergedInto {
  payment_order_id: string
  status: string
  amount: number
  total: number
}

export interface PrepareSkattekontoPaymentResult {
  order: PaymentOrderRow
  warnings: SkattekontoPaymentWarning[]
  /** Always empty since crm#1485: a same-day order nobody signed is added to (merged_into), never replaced. */
  replaced_draft_ids: string[]
  /** Set when the amount was added to the open order of the same day; the order is then a draft again. */
  merged_into?: SkattekontoMergedInto
  /** The declaration paid, when the payment was named from one (or pays exactly one declaration due on the day). */
  source: SkattekontoSourceDue | null
  /**
   * Only with source due_date: the declarations due that day, those paid
   * (components, summed) and those left out. Absent otherwise, so the other
   * sources answer exactly as before.
   */
  combined?: SkattekontoDueDateDue
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
 * same_due_date_parts for a declaration paid on its own: the other
 * declarations due the same day that ask for a payment, so the person or
 * agent sees them before an unapproved draft paying one of them is replaced.
 * Advisory: when the other parts cannot be read the warning is left out,
 * never the payment.
 */
async function sameDueDateWarning(
  supabase: SupabaseClient,
  companyId: string,
  paid: { source: SkattekontoDeclarationSource; due: SkattekontoSourceDue },
  today: string,
  replacesDraft: boolean,
  log: Logger,
): Promise<SkattekontoPaymentWarning | null> {
  const day = paid.due.due_date
  if (!day) return null
  try {
    const resolved = await resolveSkattekontoDueDate(supabase, companyId, day, today, paid)
    if (!resolved.ok) return null
    const others = resolved.combined.components.filter(
      (c) => !(c.source === paid.due.kind && c.period === paid.due.tax_period),
    )
    if (others.length === 0) return null
    return {
      code: 'same_due_date_parts',
      due: day,
      parts: others,
      total: resolved.combined.total,
      replaces_draft: replacesDraft,
      suggested_source: { source: 'due_date', due_date: day },
    }
  } catch (err) {
    log.warn('skattekonto payment: same-day declarations not read', { companyId, reason: (err as { message?: string })?.message })
    return null
  }
}

/** The earliest day a bank payment may already pay one of the declarations (their paid_from). */
function earliestPaidFrom(parts: SkattekontoSourceDue[]): string | null {
  return parts.reduce<string | null>((min, p) => (min === null || p.paid_from < min ? p.paid_from : min), null)
}

/**
 * The OCR number for the payment: the one Skatteverket reported with the
 * synced saldo, else the one derived from the org number (resolveSkattekontoOcr).
 * A reported OCR needs no org number, so the derivation is only asked when
 * there is none; null when neither exists.
 */
async function skattekontoOcr(supabase: SupabaseClient, companyId: string, log: Logger): Promise<string | null> {
  const { data, error } = await supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle()
  if (error) throw error
  const company = data as { entity_type: string | null } | null
  const orgNumber = await readCompanyOrgNumber(supabase, companyId)
  try {
    // The form decides whether the redovisare is built from a personnummer
    // (toRedovisare12); an unknown one throws, never defaults.
    return await resolveSkattekontoOcr(supabase, companyId, orgNumber ?? '', parseEntityType(company?.entity_type))
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

  // A declaration names its own amount and due date; a day names every
  // declaration due on it, summed. Without either, what Hem asks for: the
  // next charge, the shortfall against the saldo, and the bank payments
  // already covering part of it.
  let source: SkattekontoSourceDue | null = null
  let combined: SkattekontoDueDateDue | null = null
  /** The declarations the payment pays, for the filing and duplicate warnings. */
  let declarations: SkattekontoSourceDue[] = []
  let dayParts: SkattekontoSourceDue[] = []
  if (input.source?.kind === 'due_date') {
    const resolved = await resolveSkattekontoDueDate(supabase, companyId, input.source.dueDate, input.today)
    if (!resolved.ok) {
      // An AGI holding one run's totals brings its own sentence, naming the other runs (crm#1768).
      return { ok: false, code: resolved.code, details: resolved.details, ...(resolved.messageSv ? { messageSv: resolved.messageSv } : {}) }
    }
    combined = resolved.combined
    dayParts = resolved.parts
    declarations = resolved.parts.filter((p) => p.payable !== null)
    // One declaration due that day asks for a payment: the payment is that
    // declaration's, exactly as if it were named on its own.
    source = declarations.length === 1 ? (declarations[0] ?? null) : null
  } else if (input.source) {
    const resolved = await resolveSkattekontoSource(supabase, companyId, input.source, input.today)
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, details: resolved.details, ...(resolved.messageSv ? { messageSv: resolved.messageSv } : {}) }
    }
    source = resolved.due
    declarations = [source]
  }
  const due = input.source ? null : await listSkattekontoPaymentDue(supabase, companyId, input.today)
  const amount =
    chosenAmount ?? (combined ? (combined.total > 0 ? combined.total : null) : source ? source.payable : (due?.amount ?? null))
  if (amount === null) {
    // A day with one declaration answers as that declaration does.
    const only = combined ? (dayParts.length === 1 ? (dayParts[0] ?? null) : null) : source
    if (only) {
      return {
        ok: false,
        code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
        details: { reason: only.nothing_due, declared: only.declared, tax_period: only.tax_period },
      }
    }
    if (combined) {
      return {
        ok: false,
        code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
        details: {
          reason: dayParts.length === 0 ? 'no_declaration' : 'nothing_payable',
          due_date: combined.due_date,
          excluded: combined.excluded,
        },
      }
    }
    return { ok: false, code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE' }
  }
  const dueDate = combined ? combined.due_date : source ? source.due_date : (due?.due ?? null)

  const ocr = due?.ocr ?? (await skattekontoOcr(supabase, companyId, log))
  if (!ocr) return { ok: false, code: 'SKATTEKONTO_PAYMENT_OCR_MISSING' }

  // The bank takes a banking day from tomorrow on. By default the money
  // leaves the banking day before Skatteverket draws, so it is on the
  // skattekonto by the due date; without a charge to pay towards, the
  // earliest day the bank takes.
  const executionDate =
    input.executionDate != null
      ? executionDateFor(input.executionDate, input.today)
      : dueDate
        ? skattekontoPaymentDayFor(dueDate, input.today)
        : executionDateFor(earliestExecutionDateIso(input.today), input.today)
  const warnings: SkattekontoPaymentWarning[] = []
  if (input.executionDate && executionDate !== input.executionDate) {
    warnings.push({ code: 'date_moved', from: input.executionDate, to: executionDate })
  }
  if (dueDate && executionDate >= dueDate) warnings.push({ code: 'late', due: dueDate })

  // One open skattekonto payment per execution day (crm#1485). The day's
  // order nobody signed yet (a draft, or approved and not claimed for
  // signing) takes this payment as an addition, approved again as a whole;
  // signed or at the bank, the day is in payment. Another day gets its own.
  const sameDay = await readOpenSkattekontoOrderOnDay(supabase, companyId, executionDate)
  if (sameDay && isSkattekontoDayInPayment(sameDay)) {
    return {
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
      details: { payment_order_id: sameDay.id, status: sameDay.status, requested_execution_date: executionDate },
    }
  }
  const mergesInto: SkattekontoMergedInto | null = sameDay
    ? {
        payment_order_id: sameDay.id,
        status: sameDay.status,
        amount: roundOre(Number(sameDay.amount)),
        total: roundOre(Number(sameDay.amount) + amount),
      }
    : null
  let balance: SkattekontoBalance | null = null
  if (input.source) {
    // Several declarations in one payment: each warning names the one it is about.
    const named = declarations.length > 1
    const which = (part: SkattekontoSourceDue) => (named ? { source: part.kind, period: part.tax_period } : {})
    for (const part of declarations) if (!part.filed) warnings.push({ code: 'not_filed', ...which(part) })
    const since = earliestPaidFrom(declarations)
    const seen = new Set<string>()
    const paid = since ? await executedPaymentLike(supabase, companyId, amount, since) : null
    if (paid) {
      seen.add(paid.id)
      warnings.push({ code: 'possible_duplicate', payment_order_id: paid.id, executed_at: paid.executed_at })
    }
    // A declaration of the payment already paid on its own.
    if (named) {
      for (const part of declarations) {
        const alone = await executedPaymentLike(supabase, companyId, part.payable ?? part.declared, part.paid_from)
        if (!alone || seen.has(alone.id)) continue
        seen.add(alone.id)
        warnings.push({ code: 'possible_duplicate', payment_order_id: alone.id, executed_at: alone.executed_at, ...which(part) })
      }
    }
    // Only a declaration that asks for a payment is one to pay together with the others.
    if (input.source.kind !== 'due_date' && source && source.payable !== null) {
      const sameDay = await sameDueDateWarning(
        supabase,
        companyId,
        { source: input.source, due: source },
        input.today,
        false,
        log,
      )
      if (sameDay) warnings.push(sameDay)
    }
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
        ...(combined ? { combined } : {}),
        balance,
        payee: { type: 'bankgiro', label: formatPayeeLabel({ type: 'bankgiro', bankgiro }), name: SKATTEKONTO_PAYEE_NAME },
        reference: { type: 'ocr', value: ocr },
        warnings,
        replaces_drafts: 0,
        ...(mergesInto ? { merges_into: mergesInto } : {}),
      },
    }
  }

  const writer = createServiceClient()
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
  const result = rpc as {
    ok: boolean
    code?: string
    details?: unknown
    order?: PaymentOrderRow
    merged?: { previous_amount: number | string; added_amount: number | string }
  }
  if (!result.ok || !result.order) {
    log.warn('create_skattekonto_payment_order refused', { code: result.code })
    return {
      ok: false,
      code: RPC_CODES[result.code ?? ''] ?? 'UNKNOWN_ERROR',
      details: { rpc_code: result.code, rpc_details: result.details as Record<string, unknown> | undefined },
    }
  }
  const merged = result.merged
    ? {
        merged_into: {
          payment_order_id: result.order.id,
          status: String(result.order.status),
          amount: roundOre(Number(result.merged.previous_amount)),
          total: roundOre(Number(result.order.amount)),
        },
      }
    : {}
  return {
    ok: true,
    data: { order: result.order, warnings, replaced_draft_ids: [], ...merged, source, ...(combined ? { combined } : {}), balance },
  }
}
