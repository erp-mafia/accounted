/**
 * When company_settings.accounting_method may change. One rule for every
 * settings door (the dashboard's PUT /api/settings, v1 PATCH
 * /settings/tax-profile and its MCP tool), run by updateCompanySettings.
 *
 * What the method decides in the engine: whether issuing an invoice books it
 * (booksInvoicesOnIssue), and what the payment of an invoice WITHOUT a
 * verifikat of its own books. An invoice that has one is cleared against
 * 1510 / 2440 under both methods (the payment doors route on
 * invoices.journal_entry_id and supplier_invoices.registration_journal_entry_id,
 * not on the setting), and the kontantmetod year-end carries only invoices
 * without one (kontantmetod-cutoff.ts). So a switch never touches what is
 * posted; the one row it treats differently is an open invoice with no
 * verifikat of its own: under kontantmetoden its payment books the whole sale
 * or purchase (a second time when an imported verifikat already booked it),
 * under faktureringsmetoden its payment only clears 1510 / 2440 (so the sale
 * or purchase is never booked).
 *
 *  - Any change is refused while an open customer or supplier invoice lacks
 *    its own verifikat (#93: also in a year with nothing posted yet, and
 *    with no fiscal year at all; !763 checked it only before a correction).
 *  - Otherwise, while the current fiscal year has no posted verifikat, the
 *    change is free (the onboarding fix of a wrong choice).
 *  - It has posted verifikat: the change is allowed only as a correction of a
 *    setting that never matched how the company keeps its books. The caller
 *    states the reason (accounting_method_correction_reason). The method
 *    governs the year (BFL 5 kap. 2 § 3 st: the unpaid
 *    fordringar and skulder are booked at its end), and for VAT a move from
 *    faktureringsmetoden to bokslutsmetoden needs an application to
 *    Skatteverket first (ML 7 kap. 17 §): the reason says that the setting,
 *    not the company's method, was wrong.
 *
 * A correction is recorded in audit_log as GUARD_BYPASSED (guard
 * accounting_method_mid_year) with who, when and the reason, next to the
 * company_settings trigger's own row with the old and new value, so the
 * behandlingshistorik shows both (BFNAR 2013:2 p. 9.16). Verifikat the year
 * already holds from the invoice flows stay as they are; a warning names them
 * for review.
 */
import { createServiceClient } from '@/lib/supabase/server'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'

/** `audit_log.new_state.guard` of a recorded correction; behandlingshistorik renders it. */
export const ACCOUNTING_METHOD_MID_YEAR_GUARD = 'accounting_method_mid_year' as const

/** The settings-body field that carries the reason for a correction. */
export const ACCOUNTING_METHOD_CORRECTION_REASON_FIELD = 'accounting_method_correction_reason' as const

/** Open customer invoices: issued, not settled in full (credit notes and quotes are not invoices here). */
const OPEN_INVOICE_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

/** Open supplier invoices: registered and still owed. */
const OPEN_SUPPLIER_INVOICE_STATUSES = ['registered', 'approved', 'overdue', 'disputed', 'partially_paid'] as const

/**
 * Verifikat whose date the method chose: an invoice booked at issue or at
 * registration (faktureringsmetoden), or at payment (kontantmetoden).
 */
const METHOD_TIMED_SOURCE_TYPES = [
  'invoice_created',
  'supplier_invoice_registered',
  'invoice_cash_payment',
  'supplier_invoice_cash_payment',
] as const

/** Voucher labels a review warning names before it says "and N more". */
const LISTED_ENTRIES = 10

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

export interface AccountingMethodCorrection {
  from: string
  to: string
  reason: string
  fiscal_period_id: string
  fiscal_year: string | null
  posted_entries: number
  method_timed_entries: number
}

export type AccountingMethodChangeCheck =
  | { kind: 'free' }
  | { kind: 'correction'; correction: AccountingMethodCorrection; warnings: OperationWarning[] }
  | { kind: 'refused'; outcome: Refusal }

const METHOD_NAME_SV: Record<string, string> = { accrual: 'faktureringsmetoden', cash: 'kontantmetoden' }
const METHOD_NAME_EN: Record<string, string> = { accrual: 'the accrual method', cash: 'the cash method' }

function failed(error: unknown): AccountingMethodChangeCheck {
  return { kind: 'refused', outcome: { ok: false, code: 'UNKNOWN_ERROR', error } }
}

/**
 * Whether the save may set accounting_method to `requested`. Reads only;
 * every failed read fails closed.
 */
export async function checkAccountingMethodChange(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  input: { stored: string | null | undefined; requested: string | null | undefined; reason: string | null | undefined },
): Promise<AccountingMethodChangeCheck> {
  const { supabase, companyId } = ctx
  if (input.requested === undefined || input.requested === null) return { kind: 'free' }
  const from = input.stored ?? 'accrual'
  if (from === input.requested) return { kind: 'free' }

  const today = todayIsoStockholm()
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_start', today)
    .gte('period_end', today)
    .maybeSingle()
  if (periodError) return failed(periodError)
  const fiscalPeriodId = (period?.id as string | undefined) ?? null
  const fiscalYear = (period?.name as string | null | undefined) ?? null

  // Every switch, free or corrected: an open invoice without a verifikat of
  // its own is the one row the method books differently at payment.
  const [invoicesRes, supplierRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', [...OPEN_INVOICE_STATUSES])
      .is('journal_entry_id', null)
      .is('credited_invoice_id', null),
    supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('is_credit_note', false)
      .in('status', [...OPEN_SUPPLIER_INVOICE_STATUSES])
      .is('registration_journal_entry_id', null),
  ])
  if (invoicesRes.error) return failed(invoicesRes.error)
  if (supplierRes.error) return failed(supplierRes.error)
  const openInvoices = invoicesRes.count ?? 0
  const openSupplierInvoices = supplierRes.count ?? 0
  if (openInvoices + openSupplierInvoices > 0) {
    return {
      kind: 'refused',
      outcome: {
        ok: false,
        code: 'ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES',
        details: {
          fiscal_period_id: fiscalPeriodId,
          fiscal_year: fiscalYear,
          open_invoices_without_verifikat: openInvoices,
          open_supplier_invoices_without_verifikat: openSupplierInvoices,
        },
        messageSv:
          `Bokföringsmetoden kan inte bytas nu: ${openInvoices} kundfakturor och ${openSupplierInvoices} leverantörsfakturor är obetalda utan egen verifikation, ` +
          'och bytet skulle bokföra dem två gånger eller inte alls när de betalas. Bokför dem eller koppla dem till sin verifikation först.',
      },
    }
  }

  if (!fiscalPeriodId) return { kind: 'free' }
  const { count: posted, error: postedError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')
  if (postedError) return failed(postedError)
  if (!posted) return { kind: 'free' }

  const reason = input.reason?.trim() ?? ''
  if (!reason) {
    return {
      kind: 'refused',
      outcome: {
        ok: false,
        code: 'ACCOUNTING_METHOD_CHANGE_MID_YEAR',
        details: {
          fiscal_period_id: fiscalPeriodId,
          fiscal_year: fiscalYear,
          posted_entries: posted,
          correctable_with: ACCOUNTING_METHOD_CORRECTION_REASON_FIELD,
        },
        messageSv:
          `Bokföringsmetoden kan inte bytas mitt i räkenskapsåret ${String(fiscalYear)}: det finns ${posted} bokförda verifikationer. ` +
          'Byt inför nästa räkenskapsår, eller ange skälet om inställningen var fel från början (rättelse).',
      },
    }
  }

  const { data: timed, count: timedCount, error: timedError } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number', { count: 'exact' })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')
    .in('source_type', [...METHOD_TIMED_SOURCE_TYPES])
    .order('voucher_series', { ascending: true })
    .order('voucher_number', { ascending: true })
    .limit(LISTED_ENTRIES)
  if (timedError) return failed(timedError)
  const methodTimed = timedCount ?? (timed?.length ?? 0)

  const warnings: OperationWarning[] = []
  if (methodTimed > 0) {
    const labels = ((timed ?? []) as Array<{ voucher_series: string | null; voucher_number: number | null }>)
      .map((row) => `${row.voucher_series ?? ''}${row.voucher_number ?? ''}`)
    const more = methodTimed - labels.length
    const listed = labels.join(', ') + (more > 0 ? ` (+${more})` : '')
    warnings.push({
      code: 'ACCOUNTING_METHOD_CORRECTED_REVIEW_ENTRIES',
      message_sv: `${methodTimed} verifikationer i räkenskapsåret bokfördes av fakturaflödet enligt ${METHOD_NAME_SV[from] ?? from} (${listed}). De ändras inte: stäm av dem mot ${METHOD_NAME_SV[input.requested] ?? input.requested} och rätta med storno vid behov.`,
      message_en: `${methodTimed} vouchers in the fiscal year were booked by the invoice flows under ${METHOD_NAME_EN[from] ?? from} (${listed}). They stay as they are: review them against ${METHOD_NAME_EN[input.requested] ?? input.requested} and correct with a storno where needed.`,
    })
  }

  return {
    kind: 'correction',
    correction: {
      from,
      to: input.requested,
      reason,
      fiscal_period_id: fiscalPeriodId,
      fiscal_year: fiscalYear,
      posted_entries: posted,
      method_timed_entries: methodTimed,
    },
    warnings,
  }
}

const NOT_RECORDED: OperationWarning = {
  code: 'ACCOUNTING_METHOD_CORRECTION_NOT_RECORDED',
  message_sv: 'Bokföringsmetoden rättades, men skälet kunde inte sparas i behandlingshistoriken. Ändringen i sig syns där.',
  message_en: 'The accounting method was corrected, but the reason could not be saved to the processing history. The change itself is recorded there.',
}

/**
 * Write the correction to audit_log after the settings row was saved. The
 * row is written with the service role (audit_log has no INSERT policy).
 * Never throws: the settings change is already made and the trigger has
 * recorded it, so a failed write is logged and answered as a warning.
 */
export async function recordAccountingMethodCorrection(
  ctx: Pick<OperationContext, 'companyId' | 'userId' | 'log' | 'pendingOperationId'>,
  correction: AccountingMethodCorrection,
  settingsRowId: string | null,
): Promise<OperationWarning | null> {
  try {
    const { error } = await createServiceClient()
      .from('audit_log')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId,
        action: 'GUARD_BYPASSED',
        table_name: 'company_settings',
        record_id: settingsRowId,
        actor_type: 'user',
        old_state: { accounting_method: correction.from },
        new_state: {
          guard: ACCOUNTING_METHOD_MID_YEAR_GUARD,
          ...correction,
          pending_operation_id: ctx.pendingOperationId ?? null,
        },
        description: `Accounting method corrected mid-year from ${correction.from} to ${correction.to} (fiscal year ${String(correction.fiscal_year)}, ${correction.posted_entries} posted vouchers)`,
      })
    if (!error) return null
    ctx.log.error('audit_log insert failed for an accounting method correction', new Error(error.message ?? 'insert failed'), {
      code: error.code,
    })
  } catch (err) {
    ctx.log.error('audit_log insert threw for an accounting method correction', err as Error)
  }
  return NOT_RECORDED
}
